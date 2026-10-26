// The app's one ledger: opened once, shared by every screen. Screens subscribe and re-read on change.
import defaultLexicon from '../data/lexicon.json';
import { SyncEngine } from '../core/engine';
import { checkName } from '../core/identity';
import { Ledger } from '../core/ledger';
import { Lexicon, type LexiconData } from '../core/lexicon';
import { EventStore, type Clocks } from '../core/store';
import { parsePeerAddress } from '../core/syncTcp';
import { phoneExtractor } from './llm';
import { SqlitePersistence } from './sqlite';
import { device } from './device';
import { listener } from './mic';
import { discover, LocalSyncServer, TcpPeer, type Found, type SyncServerState } from './syncTcp';

declare const performance: { now(): number }; // React Native's global (monotonic, since the app started)

const clocks: Clocks = {
  wall: () => Date.now() / 1000, // untrusted (may say 1970): display only
  mono: () => performance.now() / 1000, // since the app started: trusted within this run
  random: Math.random,
};

type Listener = () => void;

class Service {
  private db = new SqlitePersistence();
  ledger: Ledger | null = null;
  sync: SyncEngine | null = null;
  syncServer: LocalSyncServer | null = null;
  syncServerState: SyncServerState = 'stopped';
  syncServerError: string | null = null;
  private listeners = new Set<Listener>();
  version = 0; // bumps on every change, so screens know to re-read

  /** The phone's name if it was set up before (else the setup screen asks). */
  savedName(): string | null {
    return this.db.loadMeta().name ?? null;
  }

  syncKey(): string {
    return this.db.loadMeta().sync_key ?? '';
  }

  peerAddresses(): string[] {
    const raw = this.db.loadMeta().sync_peers;
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`saved peer list is invalid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.some((address) => typeof address !== 'string')) {
      throw new Error('saved peer list must be a list of addresses');
    }
    return [...new Set(parsed.map((address) => parsePeerAddress(address).url))];
  }

  addPeerAddress(address: string) {
    const url = parsePeerAddress(address).url;
    const addresses = this.peerAddresses();
    if (addresses.includes(url)) throw new Error('this phone is already in the family list');
    this.db.setMeta('sync_peers', JSON.stringify([...addresses, url]));
    this.configurePeers();
    this.changed();
  }

  removePeerAddress(url: string) {
    const addresses = this.peerAddresses();
    if (!addresses.includes(url)) return;
    this.db.setMeta('sync_peers', JSON.stringify(addresses.filter((address) => address !== url)));
    this.configurePeers();
    this.changed();
  }

  setSyncKey(key: string) {
    this.db.setMeta('sync_key', key.trim());
    this.configurePeers();
    this.changed();
    void this.findPhones().catch(() => {}); // the new key may open the door to a phone found before
  }

  pref(key: string): string | null {
    return this.db.loadMeta()[`pref_${key}`] ?? null;
  }
  setPref(key: string, value: string) {
    this.db.setMeta(`pref_${key}`, value);
  }

  // --- finding family phones on the same Wi-Fi / hotspot (no addresses to type) ---------------------------
  discovery: { scanning: boolean; done: number; total: number; found: Found[]; error: string | null; at: number | null } = {
    scanning: false, done: 0, total: 0, found: [], error: null, at: null,
  };

  /** Look for family phones on this phone's network and keep every one that has the same family key. */
  async findPhones(): Promise<Found[]> {
    if (this.discovery.scanning || !this.ledger) return this.discovery.found;
    const me = this.ledger.store.deviceId;
    this.discovery = { ...this.discovery, scanning: true, done: 0, total: 0, error: null };
    this.changed();
    try {
      // a /32 or /31 is a VPN or mobile-data tunnel, not a Wi-Fi / hotspot other phones can share
      const own = (await device.localAddresses()).filter((a) => a.prefix < 31);
      if (!own.length) throw new Error('ye phone kisi Wi-Fi ya hotspot se juda nahi hai. Dono phones ko ek hi Wi-Fi par rakhein, ya ek phone ka hotspot chalu karke doosra usse jodein.');
      const found = (await discover(own, this.syncKey(), (done, total, f) => {
        this.discovery = { ...this.discovery, done, total, found: f.filter((x) => x.actor !== me) };
        this.changed();
      })).filter((x) => x.actor !== me);
      const known = this.peerAddresses();
      const names = new Map((this.sync?.status().peers ?? []).map((p) => [p.url, p.name]));
      for (const f of found.filter((x) => x.keyOk)) {
        // the same phone at a new address (the Wi-Fi gave it another one): replace the old address
        for (const url of known) if (url !== f.url && names.get(url) === f.name) this.removePeerAddress(url);
        if (!this.peerAddresses().includes(f.url)) this.addPeerAddress(f.url);
      }
      this.discovery = { ...this.discovery, scanning: false, found, at: Date.now() };
      this.changed();
      if (found.some((x) => x.keyOk)) void this.sync?.runOnce().catch(() => {});
      return found;
    } catch (e) {
      this.discovery = { ...this.discovery, scanning: false, error: (e as Error).message, at: Date.now() };
      this.changed();
      throw e;
    }
  }

  /** Every minute: if no family phone is reachable, look again (a phone came on, or its address changed). */
  private autoFind() {
    if (this.findTimer) clearInterval(this.findTimer);
    const tick = () => {
      if (!this.syncKey() || this.discovery.scanning) return;
      const peers = this.sync?.status().peers ?? [];
      if (peers.length && peers.every((p) => p.state === 'ok')) return;
      void this.findPhones().catch(() => {});
    };
    this.findTimer = setInterval(tick, 60_000);
    setTimeout(tick, 3_000);
  }
  private findTimer: ReturnType<typeof setInterval> | null = null;

  /** Open this phone's ledger (first launch: also gives it its name and the family key). */
  open(name: string, syncKey?: string) {
    checkName(name);
    if (syncKey !== undefined) this.db.setMeta('sync_key', syncKey);
    this.sync?.stop();
    this.syncServer?.stop();
    const store = EventStore.open(this.db, name, clocks);
    const saved = store.getMeta('lexicon');
    const lexicon = new Lexicon(saved ? (JSON.parse(saved) as LexiconData) : (JSON.parse(JSON.stringify(defaultLexicon)) as LexiconData), (data) =>
      store.setMeta('lexicon', JSON.stringify(data)),
    );
    this.ledger = new Ledger(store, lexicon);
    this.ledger.extractor = phoneExtractor(lexicon); // loads Qwen on first use; unavailable -> rules, with the reason
    const instance = `${store.deviceId}-${store.runId}`;
    const key = this.syncKey();
    const peers = key ? this.peerAddresses().map((address) => new TcpPeer(address, key)) : [];
    this.sync = new SyncEngine(store, peers, instance, 5, 1, (e) => console.error('sync bug', e));
    this.sync.start();
    this.syncServer = new LocalSyncServer(store, instance, () => this.syncKey(), (state, error) => {
      this.syncServerState = state;
      this.syncServerError = error;
      this.changed();
    });
    this.syncServer.start();
    store.listeners.push(() => this.changed());
    this.changed();
    this.autoFind();
    // the vendor left the mic on: keep hearing the day after the app is reopened
    if (this.pref('listening') === 'on') void listener.start(() => this.ledger!).catch(() => {});
  }

  async setListening(on: boolean) {
    if (on) await listener.start(() => this.ledger!);
    else await listener.stop();
    this.setPref('listening', on ? 'on' : 'off');
  }

  private configurePeers() {
    if (!this.sync) return;
    const key = this.syncKey();
    const peers = key ? this.peerAddresses().map((address) => new TcpPeer(address, key)) : [];
    this.sync.setPeers(peers);
    if (this.sync.status().running) this.sync.start();
  }

  changed() {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const service = new Service();
