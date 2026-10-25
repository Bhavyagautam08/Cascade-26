// The sync conversation between two phones, whatever carries the bytes. Ported from sync/protocol.py.
//
//   hello -> {name, actor, have, instance}: who the peer is and which entries it holds. The caller may
//            make this sync a shared moment (sync_id, mark): both phones note it on their own monotonic
//            clocks, and entries of the next minute carry "N s after sync X" (Event.marks).
//   pull  -> entries we lack, ordered by (actor, seq), one page at a time after a cursor
//   push  -> entries the peer lacks (from its hello), one page at a time
// Every step is idempotent and every page is saved as it arrives: a cut-off sync loses nothing and
// repeating it adds nothing. Refused entries are reported, never dropped silently.
import { checkEvent, Event } from './events';
import { EventStore, Have } from './store';

export const VERSION = 2;
export const PAGE = 500;
export const MAX_PAGE = 2000;
export const MARK_SPACING_S = 5; // at most one shared moment per peer every 5 s
export const LONG_MARK_SPACING_S = 60; // and one long moment a minute

export class Unreachable extends Error {}
export class PeerRefused extends Error {}
export class ProtocolError extends Error {}

export type Me = { name: string; actor: string; sync_id: string; mark: boolean; long: boolean };
export type Hello = { protocol: number; name: string; actor: string; instance: string; have: Have; frontier: Record<string, number> };
export type Rejected = { id: string | null; reason: string; at?: string };

export interface Peer {
  url: string;
  hello(me: Me | null): Promise<Hello>;
  pull(have: Have, after: [string, number] | null, limit: number): Promise<{ events: unknown[]; more: boolean }>;
  push(events: unknown[]): Promise<{ added: number; duplicates: number; rejected: Rejected[]; rotated: unknown }>;
}

const hex = (random: () => number, n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('');

// --- answering (the other phone asked us) ----------------------------------------------------------
export function answerHello(store: EventStore, instance: string, me: Partial<Me> | null): Hello {
  if (me?.mark && me.sync_id && me.actor) store.recordContact(me.actor, me.sync_id, null, !!me.long);
  return { protocol: VERSION, name: store.name, actor: store.deviceId, instance, have: store.have(), frontier: store.frontier() };
}

export function answerPull(store: EventStore, have: Have, after: [string, number] | null, limit: number) {
  const [page, more] = store.missing(have, after, Math.max(1, Math.min(Math.floor(limit), MAX_PAGE)));
  return { events: page, more };
}

/** Entries from the wire -> (valid events, refusals). One malformed entry doesn't sink the page. */
export function parseWire(raw: unknown[]): [Event[], Rejected[]] {
  const good: Event[] = [];
  const bad: Rejected[] = [];
  for (const item of raw) {
    const id = item && typeof item === 'object' && typeof (item as Event).id === 'string' ? (item as Event).id : null;
    try {
      const e = item as Event;
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.device_id !== 'string' || typeof e.seq !== 'number' || !e.vclock || !Array.isArray(e.postings)) {
        throw new Error('missing fields');
      }
      good.push(checkEvent({ ...e, payload: e.payload ?? {}, supersedes: e.supersedes ?? [], marks: e.marks ?? {}, mono: e.mono ?? null, raw: e.raw ?? null, wall_time: e.wall_time ?? null }));
    } catch (err) {
      bad.push({ id, reason: `not a valid entry: ${(err as Error).message}` });
    }
  }
  return [good, bad];
}

export function answerPush(store: EventStore, events: unknown[]) {
  const [good, bad] = parseWire(events);
  const res = store.ingest(good);
  return { added: res.added, duplicates: res.duplicates, rejected: [...bad, ...res.rejected], rotated: res.rotated };
}

// --- asking ------------------------------------------------------------------------------------------
function cursorOf(page: unknown[], before: [string, number] | null): [string, number] {
  const last = page[page.length - 1] as Partial<Event>;
  if (!last || typeof last.device_id !== 'string' || typeof last.seq !== 'number') {
    throw new ProtocolError(`a page ended with an entry that has no device_id/seq: ${JSON.stringify(last).slice(0, 120)}`);
  }
  const cur: [string, number] = [last.device_id, last.seq];
  if (before && (cur[0] < before[0] || (cur[0] === before[0] && cur[1] <= before[1]))) {
    throw new ProtocolError(`the peer's pages went backwards (${before} -> ${cur})`);
  }
  return cur;
}

export type ExchangeReport = {
  peer_name: string;
  peer_actor: string;
  pulled: number;
  pushed: number;
  duplicates: number;
  rejected: Rejected[];
  rotated: unknown[];
  warnings: string[];
};

/** Pull what we lack, then push what the peer lacks. knownActor spaces shared moments. */
export async function exchange(store: EventStore, peer: Peer, instance: string, page = PAGE, knownActor: string | null = null): Promise<ExchangeReport> {
  const age = knownActor ? store.contactAge(knownActor) : null;
  const longAge = knownActor ? store.contactAge(knownActor, true) : null;
  const mark = age === null || age >= MARK_SPACING_S;
  const long = mark && (longAge === null || longAge >= LONG_MARK_SPACING_S);
  const syncId = hex(store.clocks.random, 12);
  const t0 = store.clocks.mono();
  const hi = await peer.hello({ name: store.name, actor: store.deviceId, sync_id: syncId, mark, long });
  const t1 = store.clocks.mono();
  for (const key of ['name', 'actor', 'have'] as const) if (!(key in hi)) throw new ProtocolError(`${peer.url} said hello without '${key}': is it running this app?`);
  if (hi.instance === instance) throw new ProtocolError(`${peer.url} is this phone itself: remove it from the family list`);
  if (mark) store.recordContact(hi.actor, syncId, (t0 + t1) / 2, long); // the peer noted it while answering
  const rep: ExchangeReport = { peer_name: hi.name, peer_actor: hi.actor, pulled: 0, pushed: 0, duplicates: 0, rejected: [], rotated: [], warnings: [] };
  if (hi.name === store.name) rep.warnings.push(`${peer.url} is also called '${store.name}': give every phone its own name (the books stay correct, but the two are hard to tell apart)`);
  if (hi.actor === store.deviceId) rep.rotated.push(store.rotateActor(`${peer.url} writes as ${hi.actor} too: a copied ledger`));

  let after: [string, number] | null = null;
  for (;;) {
    const got = await peer.pull(store.have(), after, page);
    if (!Array.isArray(got.events) || typeof got.more !== 'boolean') throw new ProtocolError(`${peer.url} answered a pull without events/more`);
    if (got.events.length) {
      const [good, bad] = parseWire(got.events);
      const res = store.ingest(good);
      rep.pulled += res.added;
      rep.duplicates += res.duplicates;
      rep.rejected.push(...bad, ...res.rejected);
      if (res.rotated) rep.rotated.push(res.rotated);
      after = cursorOf(got.events, after);
    }
    if (!got.more) break;
    if (!got.events.length) throw new ProtocolError(`${peer.url} said there is more but sent nothing`);
  }

  let pushAfter: [string, number] | null = null;
  for (;;) {
    const [out, more] = store.missing(hi.have, pushAfter, page);
    if (out.length) {
      const sent = await peer.push(out);
      if (typeof sent.added !== 'number') throw new ProtocolError(`${peer.url} answered a push without 'added'`);
      rep.pushed += sent.added;
      rep.rejected.push(...(sent.rejected ?? []).map((r) => ({ ...r, at: 'peer' })));
      if (sent.rotated) rep.rotated.push({ ...(sent.rotated as object), at: 'peer' });
      const last = out[out.length - 1];
      pushAfter = [last.device_id, last.seq];
    }
    if (!more) break;
  }
  return rep;
}
