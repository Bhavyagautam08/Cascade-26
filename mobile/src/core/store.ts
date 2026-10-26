// Append-only event log. Ported from backend/app/ledger/store.py.
//
// The log lives in memory (a vendor's ledger is thousands of entries, not millions) and is written through
// to a Persistence (SQLite on the phone, memory in tests) in one transaction per change. Events are never
// updated or deleted; corrections are new events.
import { canonical, checkEvent, Event, Kind, Posting, Source } from './events';
import { IdentityError, checkName, nameOf, newActor } from './identity';

export const ACTOR_RE = /^[A-Za-z0-9_.-]+$/; // no ":" (ids are actor:seq), no spaces
export const MARK_WINDOW_S = 60; // entries carry the syncs of the last minute (twins always share one)
export const LONG_MARK_WINDOW_S = 600; // ...and the once-a-minute long syncs of the last 10 minutes
export const CLASH = 'different content already stored under this id';

export type Have = Record<string, [number, number][]>; // {actor: [[first_seq, last_seq], ...]}

export type IngestResult = {
  added: number;
  duplicates: number; // already had it (normal on re-sync)
  rejected: { id: string | null; reason: string }[];
  rotated: { from: string; to: string; because: string } | null;
};

/** Where the log is kept. saveEvents must be all-or-nothing. */
export interface Persistence {
  loadEvents(): Event[];
  loadMeta(): Record<string, string>;
  saveEvents(events: Event[]): void;
  setMeta(key: string, value: string): void;
}

export class MemoryPersistence implements Persistence {
  events: Event[] = [];
  meta: Record<string, string> = {};
  failNext: Error | null = null; // tests: make the next save fail
  wipe() {
    this.events = [];
    this.meta = {};
  }
  loadEvents() {
    return this.events.map((e) => JSON.parse(JSON.stringify(e)));
  }
  loadMeta() {
    return { ...this.meta };
  }
  saveEvents(events: Event[]) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.events.push(...events.map((e) => JSON.parse(JSON.stringify(e))));
  }
  setMeta(key: string, value: string) {
    this.meta[key] = value;
  }
}

export type Clocks = {
  wall: () => number; // untrusted, display only (seconds)
  mono: () => number; // trusted within this run only (seconds)
  random: () => number; // [0, 1), for actor ids and run ids
};

function holds(ranges: [number, number][], seq: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (seq < a) hi = mid - 1;
    else if (seq > b) lo = mid + 1;
    else return true;
  }
  return false;
}

export class EventStore {
  deviceId: string;
  readonly runId: string;
  /** Shared moments with peers: {peer actor: [sync id, our mono time, long]}, newest last (Event.marks). */
  contacts: Record<string, [string, number, boolean][]> = {};
  /** Called with "local" or "ingest" after the log gained entries (the sync engine wakes on it). */
  listeners: ((why: 'local' | 'ingest') => void)[] = [];
  private byId = new Map<string, Event>();
  private meta: Record<string, string>;

  constructor(private db: Persistence, deviceId: string, readonly clocks: Clocks) {
    this.deviceId = deviceId;
    this.runId = Array.from({ length: 8 }, () => '0123456789abcdef'[Math.floor(clocks.random() * 16)]).join('');
    for (const e of db.loadEvents()) this.byId.set(e.id, e);
    this.meta = db.loadMeta();
  }

  /** The app's way in: the ledger of device `name`, writing as this ledger's own actor (identity.ts). */
  static open(db: Persistence, name: string, clocks: Clocks): EventStore {
    checkName(name);
    const s = new EventStore(db, name, clocks);
    const owner = s.getMeta('name');
    let actor = s.getMeta('actor');
    if (owner != null && owner !== name) {
      throw new IdentityError(`this ledger belongs to '${owner}', but the device is set up as '${name}'`);
    }
    if (actor == null) {
      actor = newActor(name, clocks.random);
      s.setMeta('name', name);
      s.setMeta('actor', actor);
    }
    s.deviceId = actor;
    return s;
  }

  // --- facts about this ledger ------------------------------------------------------------------
  getMeta(key: string): string | null {
    return this.meta[key] ?? null;
  }
  setMeta(key: string, value: string) {
    this.db.setMeta(key, value);
    this.meta[key] = value;
  }
  get name(): string {
    return this.getMeta('name') ?? nameOf(this.deviceId);
  }
  previousActors(): string[] {
    return JSON.parse(this.getMeta('previous_actors') ?? '[]');
  }
  rotateActor(because: string) {
    const from = this.deviceId;
    const to = newActor(this.name, this.clocks.random);
    this.setMeta('previous_actors', JSON.stringify([...this.previousActors(), from]));
    this.setMeta('actor', to);
    this.deviceId = to;
    return { from, to, because };
  }

  // --- shared moments with peers (in memory: a monotonic clock means nothing after a restart) -------
  private static fresh(now: number, t: number, long: boolean) {
    return now - t >= 0 && now - t <= (long ? LONG_MARK_WINDOW_S : MARK_WINDOW_S);
  }
  recordContact(peer: string, syncId: string, at: number | null = null, long = false) {
    const now = this.clocks.mono();
    const keep = (this.contacts[peer] ?? []).filter(([s, t, lg]) => EventStore.fresh(now, t, lg) && s !== syncId);
    this.contacts[peer] = [...keep, [syncId, at ?? now, long]];
  }
  contactAge(peer: string, long = false): number | null {
    const ts = (this.contacts[peer] ?? []).filter(([, , lg]) => lg || !long).map(([, t]) => t);
    return ts.length ? this.clocks.mono() - ts[ts.length - 1] : null;
  }
  private marksAt(now: number): Record<string, [string, number][]> {
    const out: Record<string, [string, number][]> = {};
    for (const [peer, lst] of Object.entries(this.contacts)) {
      const recent = lst.filter(([, t, lg]) => EventStore.fresh(now, t, lg)).map(([s, t]): [string, number] => [s, round3(now - t)]);
      if (recent.length) out[peer] = recent;
    }
    return out;
  }

  // --- reading -----------------------------------------------------------------------------------
  all(): Event[] {
    return [...this.byId.values()];
  }
  get(id: string): Event | undefined {
    return this.byId.get(id);
  }

  private seqsByDevice(): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (const e of this.byId.values()) {
      const l = m.get(e.device_id) ?? [];
      l.push(e.seq);
      m.set(e.device_id, l);
    }
    for (const l of m.values()) l.sort((a, b) => a - b);
    return m;
  }

  /** Per device, the highest seq held with no gaps (1..n). The vector clock claims only this. */
  frontier(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [d, seqs] of this.seqsByDevice()) {
      let n = 0;
      for (const s of seqs) {
        if (s === n + 1) n = s;
        else if (s > n + 1) break;
      }
      if (n > 0) out[d] = n;
    }
    return out;
  }

  /** Per device, the ranges held: {"a": [[1, 40], [42, 50]]}, so a peer sends exactly what's missing. */
  have(): Have {
    const out: Have = {};
    for (const [d, seqs] of [...this.seqsByDevice()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const r: [number, number][] = [];
      for (const s of seqs) {
        if (r.length && r[r.length - 1][1] + 1 === s) r[r.length - 1][1] = s;
        else r.push([s, s]);
      }
      out[d] = r;
    }
    return out;
  }

  /** Entries a peer holding `have` lacks, ordered by (actor, seq), after the cursor. -> [page, more]. */
  missing(have: Have, after: [string, number] | null = null, limit: number | null = null): [Event[], boolean] {
    const held: Record<string, [number, number][]> = {};
    for (const [d, rs] of Object.entries(have)) held[d] = rs.map(([lo, hi]): [number, number] => [Number(lo), Number(hi)]).sort((x, y) => x[0] - y[0]);
    const [d0, s0] = after ?? ['', 0];
    const wanted = this.all()
      .filter((e) => e.device_id > d0 || (e.device_id === d0 && e.seq > s0))
      .filter((e) => !holds(held[e.device_id] ?? [], e.seq))
      .sort((a, b) => (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : a.seq - b.seq));
    const more = limit != null && wanted.length > limit;
    return [limit != null ? wanted.slice(0, limit) : wanted, more];
  }

  private maxOwnSeq(): number {
    let m = 0;
    for (const e of this.byId.values()) if (e.device_id === this.deviceId && e.seq > m) m = e.seq;
    return m;
  }

  // --- writing -----------------------------------------------------------------------------------
  appendLocal(
    kind: Kind,
    source: Source,
    postings: Posting[],
    opts: { payload?: Record<string, unknown>; confidence?: number; raw?: string | null; supersedes?: string[] } = {},
  ): Event {
    const vc = this.frontier();
    const seq = this.maxOwnSeq() + 1;
    vc[this.deviceId] = seq;
    const now = this.clocks.mono();
    const ev = checkEvent({
      id: `${this.deviceId}:${seq}`,
      device_id: this.deviceId,
      seq,
      vclock: vc,
      wall_time: this.clocks.wall(),
      kind,
      source,
      confidence: opts.confidence ?? 1,
      payload: opts.payload ?? {},
      postings,
      raw: opts.raw ?? null,
      supersedes: opts.supersedes ?? [],
      mono: [this.runId, round3(now)],
      marks: this.marksAt(now),
    });
    this.db.saveEvents([ev]);
    this.byId.set(ev.id, ev);
    this.notify('local');
    return ev;
  }

  /** Merge events from a peer: set union, so order doesn't matter. All-or-nothing. */
  ingest(events: Event[]): IngestResult {
    const res: IngestResult = { added: 0, duplicates: 0, rejected: [], rotated: null };
    const me = this.deviceId;
    const foreignOwn: string[] = [];
    const fresh = new Map<string, Event>();
    for (const ev of events) {
      let reason: string | null = null;
      if (ev.device_id === 'fusion' || !ACTOR_RE.test(ev.device_id) || !(ev.seq >= 1) || ev.id !== `${ev.device_id}:${ev.seq}`) {
        reason = 'id must be device_id:seq with seq >= 1 (device_id: letters, digits, . _ -)';
      } else if (ev.vclock[ev.device_id] !== ev.seq) {
        reason = 'vclock must count the event itself';
      } else {
        try {
          checkEvent(ev);
        } catch (e) {
          reason = `not a valid entry: ${(e as Error).message}`;
        }
      }
      if (reason == null) {
        const held = this.byId.get(ev.id) ?? fresh.get(ev.id);
        if (!held) {
          fresh.set(ev.id, ev);
          if (ev.device_id === me) foreignOwn.push(ev.id);
          continue;
        }
        if (canonical(held) === canonical(ev)) {
          res.duplicates += 1;
          continue;
        }
        reason = CLASH;
        if (ev.device_id === me) foreignOwn.push(ev.id);
      }
      res.rejected.push({ id: ev.id ?? null, reason });
    }
    if (fresh.size) {
      this.db.saveEvents([...fresh.values()]); // throws -> nothing was added (memory untouched too)
      for (const [id, ev] of fresh) this.byId.set(id, ev);
      res.added = fresh.size;
    }
    if (foreignOwn.length) {
      res.rotated = this.rotateActor(
        `another ledger wrote as ${me} (${foreignOwn.slice(0, 3).join(', ')}${foreignOwn.length > 3 ? ', ...' : ''}): a copied or restored ledger`,
      );
    }
    if (res.added) this.notify('ingest');
    return res;
  }

  private notify(why: 'local' | 'ingest') {
    for (const fn of [...this.listeners]) fn(why);
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Deterministic order every device agrees on: vector-clock sum, then (actor, seq). Wall time ignored. */
export function causalOrder(events: Event[]): Event[] {
  const sum = (e: Event) => Object.values(e.vclock).reduce((s, v) => s + v, 0);
  return [...events].sort(
    (a, b) => sum(a) - sum(b) || (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0) || a.seq - b.seq,
  );
}
