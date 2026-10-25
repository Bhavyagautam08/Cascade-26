// Keeps the family's phones in sync by itself. Ported from sync/engine.py.
//
// A round exchanges with every peer at once, every intervalS and ~minGapS after any new entry, so
// phones together stay seconds apart. Rounds never overlap. Each peer's last outcome is kept for the
// Family screen using the monotonic clock only. Errors are never swallowed: unreachable / refused /
// protocol errors are shown per peer, and a bug is shown and reported to onBug.
import { exchange, Peer, PeerRefused, ProtocolError, Rejected, Unreachable } from './protocol';
import type { EventStore } from './store';

const KEEP_REJECTED = 20;

export type PeerState = {
  url: string;
  name: string | null;
  actor: string | null;
  state: 'never' | 'ok' | 'unreachable' | 'refused' | 'error';
  lastOk: number | null;
  lastAttempt: number | null;
  lastError: string | null;
  failuresInARow: number;
  last: { pulled?: number; pushed?: number; duplicates?: number };
  pulledTotal: number;
  pushedTotal: number;
  rejected: Rejected[];
  warnings: string[];
};

export class SyncEngine {
  states = new Map<string, PeerState>();
  rotations: Record<string, unknown>[] = [];
  rounds = 0;
  private running: Promise<Record<string, unknown>> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private wanted = false;
  private lastRoundEnd = -Infinity;

  constructor(
    readonly store: EventStore,
    public peers: Peer[],
    readonly instance: string,
    public intervalS = 5,
    readonly minGapS = 1,
    readonly onBug: (e: unknown) => void = () => {},
  ) {
    for (const p of peers) this.states.set(p.url, blank(p.url));
    store.listeners.push(() => this.wake());
  }

  setPeers(peers: Peer[]) {
    this.peers = peers;
    for (const p of peers) if (!this.states.has(p.url)) this.states.set(p.url, blank(p.url));
    for (const url of [...this.states.keys()]) if (!peers.some((p) => p.url === url)) this.states.delete(url);
  }

  get auto() {
    return this.intervalS > 0 && this.peers.length > 0;
  }

  start() {
    this.started = true;
    this.schedule(0);
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A new entry here or from a peer: sync soon (after minGapS), not on the next tick. */
  wake() {
    if (!this.started) return;
    const now = this.store.clocks.mono();
    this.schedule(Math.max(0, this.minGapS - (now - this.lastRoundEnd)) * 1000);
  }

  private schedule(ms: number) {
    if (!this.started || !this.auto) return;
    if (this.running) {
      this.wanted = true; // run again right after the current round
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runOnce().finally(() => this.schedule(this.wanted ? this.minGapS * 1000 : this.intervalS * 1000));
      this.wanted = false;
    }, ms);
  }

  /** One round with every peer, in parallel. Concurrent callers share the round in progress. */
  runOnce(): Promise<Record<string, unknown>> {
    if (this.running) return this.running;
    this.running = (async () => {
      this.rounds++;
      const results = await Promise.all(this.peers.map((p) => this.one(p)));
      return Object.fromEntries(this.peers.map((p, i) => [p.url, results[i]]));
    })().finally(() => {
      this.running = null;
      this.lastRoundEnd = this.store.clocks.mono();
    });
    return this.running;
  }

  private async one(peer: Peer) {
    const st = this.states.get(peer.url) ?? blank(peer.url);
    this.states.set(peer.url, st);
    const now = this.store.clocks.mono();
    st.lastAttempt = now;
    try {
      const rep = await exchange(this.store, peer, this.instance, undefined, st.actor);
      Object.assign(st, { state: 'ok', lastOk: now, lastError: null, failuresInARow: 0, name: rep.peer_name, actor: rep.peer_actor, warnings: rep.warnings });
      st.last = { pulled: rep.pulled, pushed: rep.pushed, duplicates: rep.duplicates };
      st.pulledTotal += rep.pulled;
      st.pushedTotal += rep.pushed;
      if (rep.rejected.length) st.rejected = [...st.rejected, ...rep.rejected].slice(-KEEP_REJECTED);
      for (const r of rep.rotated) this.rotations.push({ ...(r as object), peer: peer.url });
      return { ...rep, added: rep.pulled };
    } catch (e) {
      const state = e instanceof Unreachable ? 'unreachable' : e instanceof PeerRefused ? 'refused' : 'error';
      const msg = e instanceof Unreachable || e instanceof PeerRefused || e instanceof ProtocolError ? (e as Error).message : `bug: ${(e as Error)?.name}: ${(e as Error)?.message}`;
      if (state === 'error' && !(e instanceof ProtocolError)) this.onBug(e);
      st.state = state;
      st.lastError = msg;
      st.failuresInARow++;
      return { error: msg, state };
    }
  }

  status() {
    const now = this.store.clocks.mono();
    const ago = (t: number | null) => (t == null ? null : Math.round((now - t) * 10) / 10);
    return {
      auto: this.auto,
      intervalS: this.intervalS,
      running: this.started,
      rounds: this.rounds,
      name: this.store.name,
      actor: this.store.deviceId,
      previousActors: this.store.previousActors(),
      rotations: this.rotations,
      peers: [...this.states.values()].map((s) => ({ ...s, lastOkSAgo: ago(s.lastOk), lastAttemptSAgo: ago(s.lastAttempt) })),
    };
  }
}

const blank = (url: string): PeerState => ({
  url, name: null, actor: null, state: 'never', lastOk: null, lastAttempt: null, lastError: null, failuresInARow: 0, last: {}, pulledTotal: 0, pushedTotal: 0, rejected: [], warnings: [],
});
