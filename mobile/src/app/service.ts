// The app's one ledger: opened once, shared by every screen. Screens subscribe and re-read on change.
import defaultLexicon from '../data/lexicon.json';
import { SyncEngine } from '../core/engine';
import { checkName } from '../core/identity';
import { Ledger } from '../core/ledger';
import { Lexicon, type LexiconData } from '../core/lexicon';
import { EventStore, type Clocks } from '../core/store';
import { phoneExtractor } from './llm';
import { SqlitePersistence } from './sqlite';

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
  private listeners = new Set<Listener>();
  version = 0; // bumps on every change, so screens know to re-read

  /** The phone's name if it was set up before (else the setup screen asks). */
  savedName(): string | null {
    return this.db.loadMeta().name ?? null;
  }

  syncKey(): string {
    return this.db.loadMeta().sync_key ?? '';
  }

  /** Open this phone's ledger (first launch: also gives it its name and the family key). */
  open(name: string, syncKey?: string) {
    checkName(name);
    if (syncKey !== undefined) this.db.setMeta('sync_key', syncKey);
    const store = EventStore.open(this.db, name, clocks);
    const saved = store.getMeta('lexicon');
    const lexicon = new Lexicon(saved ? (JSON.parse(saved) as LexiconData) : (JSON.parse(JSON.stringify(defaultLexicon)) as LexiconData), (data) =>
      store.setMeta('lexicon', JSON.stringify(data)),
    );
    this.ledger = new Ledger(store, lexicon);
    this.ledger.extractor = phoneExtractor(lexicon); // loads Qwen on first use; unavailable -> rules, with the reason
    this.sync = new SyncEngine(store, [], `${store.deviceId}-${store.runId}`, 5, 1, (e) => console.error('sync bug', e));
    store.listeners.push(() => this.changed());
    this.changed();
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
