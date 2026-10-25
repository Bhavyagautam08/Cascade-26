// Cross-modal fusion, two-phone twins and disputes: a pure, deterministic VIEW over the log.
// Ported rule for rule from backend/app/ledger/fusion.py (see that file and docs/ARCHITECTURE.md 6.4).
//
// Every phone runs this on the same synced set and gets the same answer, so no phone ever stores a "merge".
// Only human decisions are stored: `same`, `separate`, settle, correct, void. Latest per pair wins.
// Time between entries never comes from a wall clock: Event.mono (one device, one run) or shared sync
// moments (Event.marks, two devices). Words are not used to spot twins (measured: eval/twin_phones.py).
import { concurrent as vConcurrent, merge } from './clock';
import { dayOfEvents } from './days';
import type { Event, Kind, Posting } from './events';
import { causalOrder } from './store';

export const ECHO_S = 10; // one utterance cut twice by the mic: seconds apart
export const TWIN_S = 30; // one utterance on two phones: the slower phone's speech + model lag
export const CROSS_MODAL_S = 300; // a spoken payment vs. its bank SMS: the SMS can arrive minutes later
export const SAME_DEVICE_WINDOW = 5; // cross-modal duplicates on one device: at most this many entries apart
const CREDIT_KINDS: Kind[] = ['credit_paid', 'credit_given'];

type Evidence = ['exact', number] | ['far', null] | ['unknown', null];

export type Conflict = {
  ids: string[];
  party: string | null;
  kind: Kind;
  item: unknown;
  claims_paise: [number, number];
  booked_paise: number;
  disputed_paise: number;
  suspense_paise: number;
  why: string;
};

export type FusionReport = {
  effective: Event[];
  duplicates: string[][];
  conflicts: Conflict[];
  possible_conflicts: { ids: string[]; party: string | null; kind: Kind; claims_paise: number[]; counted_as: string }[];
  possible_duplicates: {
    ids: string[];
    kind: Kind;
    item: unknown;
    party: string | null;
    qty: unknown;
    amount_paise: number;
    devices: string[];
    counted_as: string;
    why: string;
  }[];
};

export const amountOf = (e: Event) => e.postings.reduce((s, p) => s + (p.amount > 0 ? p.amount : 0), 0);
const party = (e: Event): string | null => String(e.payload.party ?? '').toLowerCase() || null;
const subjectKey = (e: Event) => JSON.stringify([e.kind, e.payload.item ?? null, party(e)]);
const sameTrade = (a: Event, b: Event) =>
  subjectKey(a) === subjectKey(b) && amountOf(a) === amountOf(b) && (a.payload.qty ?? null) === (b.payload.qty ?? null);
const itemFits = (a: Event, b: Event) => {
  const ia = a.payload.item ?? null;
  const ib = b.payload.item ?? null;
  return ia === ib || ia == null || ib == null;
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const concurrent = (a: Event, b: Event) => vConcurrent(a.vclock, b.vclock);

export function evidence(a: Event, b: Event): Evidence {
  if (a.device_id === b.device_id) {
    if (a.mono && b.mono && a.mono[0] === b.mono[0]) return ['exact', Math.abs(a.mono[1] - b.mono[1])];
    return ['unknown', null]; // a restart in between, or entries from before Event.mono
  }
  const ma = a.marks[b.device_id];
  const mb = b.marks[a.device_id];
  if (!ma?.length || !mb?.length) return ['unknown', null];
  const theirs = new Map(mb);
  const gaps = ma.filter(([s]) => theirs.has(s)).map(([s, t]) => Math.abs(t - (theirs.get(s) as number)));
  return gaps.length ? ['exact', Math.round(Math.min(...gaps) * 1000) / 1000] : ['far', null];
}

export const apartS = (a: Event, b: Event) => evidence(a, b)[1];

function echo(a: Event, b: Event): boolean {
  const ra = (a.raw ?? '').trim().toLowerCase();
  if (!(a.device_id === b.device_id && a.source === b.source && Math.abs(a.seq - b.seq) === 1 && ra !== '' && ra === (b.raw ?? '').trim().toLowerCase() && sameTrade(a, b))) {
    return false;
  }
  if (a.mono && b.mono) {
    const [k, t] = evidence(a, b);
    return k === 'exact' && (t as number) <= ECHO_S;
  }
  return true; // entries from before Event.mono: back to back is all we know
}

/** Do two amounts look like one figure misheard? An extra/missing zero (40/400) or swapped digits (140/410). */
export function misheard(x: number, y: number): boolean {
  const [lo, hi] = [Math.min(x, y), Math.max(x, y)];
  if (lo <= 0 || lo === hi) return false;
  if (hi % lo === 0 && String(Math.floor(hi / lo)).replace(/^0+|0+$/g, '') === '1') return true;
  const a = String(lo % 100 === 0 ? lo / 100 : lo);
  const b = String(hi % 100 === 0 ? hi / 100 : hi);
  return [...a].sort().join('') === [...b].sort().join('');
}

const pairKey = (x: string, y: string) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);

/** A person's decisions, the causally latest per pair: "same" | "separate". */
function decisions(events: Event[]): Map<string, 'same' | 'separate'> {
  const out = new Map<string, 'same' | 'separate'>();
  for (const e of causalOrder(events)) {
    for (const key of ['separate', 'same'] as const) {
      const ids = (e.payload[key] as string[] | undefined) ?? [];
      for (let i = 0; i < ids.length; i++) for (const y of ids.slice(i + 1)) out.set(pairKey(ids[i], y), key);
    }
  }
  return out;
}

/** Candidate pairs with equal key, without comparing everything with everything (see fusion.py _pairs). */
function* pairs(evs: Event[], key: (e: Event) => string, day: Record<string, number>, extra: Iterable<[string, string]>): Generator<[Event, Event]> {
  const pos = new Map(evs.map((e, i) => [e.id, i]));
  const seen = new Set<string>();
  const emit = (a: Event, b: Event): [Event, Event] | null => {
    if (a.id === b.id || key(a) !== key(b)) return null;
    if ((pos.get(a.id) as number) > (pos.get(b.id) as number)) [a, b] = [b, a];
    const k = `${a.id}\u0000${b.id}`;
    if (seen.has(k)) return null;
    seen.add(k);
    return [a, b];
  };

  const byDevice = new Map<string, Event[]>();
  for (const e of evs) byDevice.set(e.device_id, [...(byDevice.get(e.device_id) ?? []), e]);
  for (const lst of byDevice.values()) {
    lst.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < lst.length; i++) {
      for (const b of lst.slice(i + 1)) {
        if (b.seq - lst[i].seq > SAME_DEVICE_WINDOW) break;
        const p = emit(lst[i], b);
        if (p) yield p;
      }
    }
  }

  const byMoment = new Map<string, Event[]>();
  for (const e of evs) for (const marks of Object.values(e.marks)) for (const [sid] of marks) byMoment.set(sid, [...(byMoment.get(sid) ?? []), e]);
  for (const lst of byMoment.values()) {
    for (let i = 0; i < lst.length; i++) {
      for (const b of lst.slice(i + 1)) {
        if (lst[i].device_id === b.device_id) continue;
        const p = emit(lst[i], b);
        if (p) yield p;
      }
    }
  }

  const byDay = new Map<string, Event[]>();
  for (const e of evs) {
    const k = `${key(e)}\u0000${day[e.id]}`;
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  for (const lst of byDay.values()) {
    const devices = [...new Set(lst.map((e) => e.device_id))].sort(cmp); // sorted: the same pairing on every phone
    for (const d1 of devices) {
      for (const d2 of devices) {
        if (d1 >= d2) continue;
        const one = lst.filter((e) => e.device_id === d1);
        const two = lst.filter((e) => e.device_id === d2);
        for (const a of one.filter((e) => !e.marks[d2]?.length)) for (const b of two) { const p = emit(a, b); if (p) yield p; }
        for (const b of two.filter((e) => !e.marks[d1]?.length)) for (const a of one) { const p = emit(a, b); if (p) yield p; }
      }
    }
  }

  const byId = new Map(evs.map((e) => [e.id, e]));
  for (const [x, y] of extra) {
    const a = byId.get(x);
    const b = byId.get(y);
    if (a && b) {
      const p = emit(a, b);
      if (p) yield p;
    }
  }
}

type Strength = [number, number];

function duplicateLink(a: Event, b: Event, day: Record<string, number>, said: string | undefined): Strength | null {
  if (said === 'separate') return null;
  if (said === 'same') return [0, 0];
  const [kind, t] = evidence(a, b);
  if (a.device_id === b.device_id) {
    if (a.source !== b.source && sameTrade(a, b) && Math.abs(a.seq - b.seq) <= SAME_DEVICE_WINDOW && day[a.id] === day[b.id] && !(kind === 'exact' && (t as number) > CROSS_MODAL_S)) {
      return kind === 'exact' ? [1, t as number] : [2, Math.abs(a.seq - b.seq)];
    }
    return null;
  }
  if (kind === 'exact') {
    if ((t as number) <= TWIN_S && itemFits(a, b)) return [1, t as number];
    if (a.source !== b.source && sameTrade(a, b) && (t as number) <= CROSS_MODAL_S) return [1, t as number];
    return null;
  }
  if (kind === 'unknown' && a.source !== b.source && sameTrade(a, b) && concurrent(a, b) && day[a.id] === day[b.id]) return [2, 0];
  return null;
}

class Groups {
  parent = new Map<string, string>();
  members = new Map<string, Event[]>();
  constructor(evs: Event[]) {
    for (const e of evs) {
      this.parent.set(e.id, e.id);
      this.members.set(e.id, [e]);
    }
  }
  root(x: string): string {
    while (this.parent.get(x) !== x) {
      const p = this.parent.get(this.parent.get(x) as string) as string;
      this.parent.set(x, p);
      x = p;
    }
    return x;
  }
  join(a: Event, b: Event, fits: ((x: Event, y: Event) => boolean) | null): boolean {
    const ra = this.root(a.id);
    const rb = this.root(b.id);
    if (ra === rb) return false;
    const ma = this.members.get(ra) as Event[];
    const mb = this.members.get(rb) as Event[];
    if (fits) {
      const slots = new Set(ma.map((e) => `${e.device_id}\u0000${e.source}`));
      if (mb.some((e) => slots.has(`${e.device_id}\u0000${e.source}`))) return false;
      if (!ma.every((x) => mb.every((y) => fits(x, y)))) return false; // every member is the same trade
    }
    this.parent.set(rb, ra);
    this.members.set(ra, [...ma, ...mb]);
    this.members.delete(rb);
    return true;
  }
}

function synthetic(ids: string[], members: Event[], kind: Kind, postings: Posting[], confidence: number, payload: Record<string, unknown>): Event {
  let vc: Record<string, number> = {};
  for (const m of members) vc = merge(vc, m.vclock);
  const sorted = [...ids].sort(cmp);
  return {
    id: `fused:${sorted.join('+')}`,
    device_id: 'fusion',
    seq: 0,
    vclock: vc,
    wall_time: null,
    kind,
    source: members[0].source,
    confidence: Math.min(confidence, 1),
    payload,
    postings,
    raw: members.map((m) => m.raw ?? '').join(' | '),
    supersedes: sorted,
    mono: null,
    marks: {},
  };
}

function dispute(a: Event, b: Event, why: string): [Event, Conflict] {
  const [lo, hi] = amountOf(a) <= amountOf(b) ? [a, b] : [b, a];
  const diff = amountOf(hi) - amountOf(lo);
  const p = party(a);
  const postings: Posting[] = lo.postings.map((x) => ({ account: x.account, amount: x.amount }));
  let suspense = 0;
  if (CREDIT_KINDS.includes(a.kind) && p) {
    const receivable = `receivable:${p}`;
    if (a.kind === 'credit_paid') postings.push({ account: 'suspense', amount: diff }, { account: receivable, amount: -diff });
    else postings.push({ account: receivable, amount: diff }, { account: 'suspense', amount: -diff });
    suspense = diff;
  }
  const ids = [a.id, b.id];
  const ev = synthetic(ids, [a, b], a.kind, postings, Math.min(a.confidence, b.confidence), { ...lo.payload, disputed_paise: diff });
  return [
    ev,
    {
      ids,
      party: p,
      kind: a.kind,
      item: a.payload.item ?? b.payload.item ?? null,
      claims_paise: [amountOf(lo), amountOf(hi)],
      booked_paise: amountOf(lo),
      disputed_paise: diff,
      suspense_paise: suspense,
      why,
    },
  ];
}

const cmpTuple = (x: (number | string)[], y: (number | string)[]) => {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

export function fuse(events: Event[]): FusionReport {
  const superseded = new Set(events.flatMap((e) => e.supersedes));
  const decided = decisions(events);
  const live = causalOrder(events).filter((e) => !superseded.has(e.id) && e.postings.length > 0);
  const noPostings = events.filter((e) => !superseded.has(e.id) && e.postings.length === 0);
  const pos = new Map(live.map((e, i) => [e.id, i]));
  const day = dayOfEvents(events);
  const samePairs: [string, string][] = [...decided.entries()].filter(([, d]) => d === 'same').map(([k]) => k.split('\u0000') as [string, string]);
  const said = (a: Event, b: Event) => decided.get(pairKey(a.id, b.id));
  const report: FusionReport = { effective: [], duplicates: [], conflicts: [], possible_conflicts: [], possible_duplicates: [] };
  const groups = new Groups(live);
  const money = (e: Event) => JSON.stringify([e.kind, party(e), amountOf(e)]);
  const P = (e: Event) => pos.get(e.id) as number;

  // 1. echoes
  for (const [a, b] of pairs(live, money, day, [])) if (echo(a, b) && said(a, b) !== 'separate') groups.join(a, b, null);

  // 2 + 3. cross-modal duplicates and twins: the closest pairs first
  const links: [Strength, number, number, Event, Event][] = [];
  for (const [a, b] of pairs(live, money, day, samePairs)) {
    const s = duplicateLink(a, b, day, said(a, b));
    if (s) links.push([s, P(a), P(b), a, b]);
  }
  links.sort((x, y) => cmpTuple([...x[0], x[1], x[2]], [...y[0], y[1], y[2]]));
  const fits = (x: Event, y: Event) => duplicateLink(x, y, day, said(x, y)) != null || echo(x, y);
  for (const [, , , a, b] of links) groups.join(a, b, fits);

  const alone = live.filter((e) => (groups.members.get(groups.root(e.id)) ?? []).length === 1);

  // 4. disputes: one utterance, two amounts (closest first, one-to-one)
  const subject = (e: Event) => JSON.stringify([e.kind, party(e)]);
  const found: [Strength, number, number, Event, Event, string][] = [];
  const maybeConflicts: [Event, Event][] = [];
  for (const [a, b] of pairs(alone, subject, day, [])) {
    const x = amountOf(a);
    const y = amountOf(b);
    if (a.device_id === b.device_id || said(a, b) === 'separate' || !itemFits(a, b) || x === y || Math.min(x, y) <= 0) continue;
    const [kind, t] = evidence(a, b);
    if (kind === 'exact' && (t as number) <= TWIN_S) {
      found.push([[1, t as number], P(a), P(b), a, b, `heard ${t} s apart on two phones`]);
    } else if (kind === 'unknown' && CREDIT_KINDS.includes(a.kind) && party(a) && concurrent(a, b) && day[a.id] === day[b.id]) {
      if (misheard(x, y)) found.push([[2, 0], P(a), P(b), a, b, 'the amounts look like one figure misheard']);
      else maybeConflicts.push([a, b]);
    }
  }
  found.sort((x, y) => cmpTuple([...x[0], x[1], x[2]], [...y[0], y[1], y[2]]));
  const disputed = new Map<string, Event>();
  for (const [, , , a, b, why] of found) {
    if (disputed.has(a.id) || disputed.has(b.id)) continue;
    const [ev, c] = dispute(a, b, why);
    disputed.set(a.id, ev);
    disputed.set(b.id, ev);
    report.conflicts.push(c);
  }
  for (const [a, b] of maybeConflicts) {
    if (!disputed.has(a.id) && !disputed.has(b.id)) {
      report.possible_conflicts.push({ ids: [a.id, b.id], party: party(a), kind: a.kind, claims_paise: [amountOf(a), amountOf(b)].sort((m, n) => m - n), counted_as: 'two separate payments' });
    }
  }

  // 5. possible duplicates: identical, out of touch, nothing to tell one from two (one-to-one)
  const paired = new Set<string>();
  for (const [a, b] of pairs(alone.filter((e) => !disputed.has(e.id)), money, day, [])) {
    if (paired.has(a.id) || paired.has(b.id) || a.device_id === b.device_id || said(a, b) !== undefined || !sameTrade(a, b) || !concurrent(a, b) || day[a.id] !== day[b.id] || evidence(a, b)[0] !== 'unknown') continue;
    paired.add(a.id);
    paired.add(b.id);
    report.possible_duplicates.push({
      ids: [a.id, b.id],
      kind: a.kind,
      item: a.payload.item ?? null,
      party: party(a),
      qty: a.payload.qty ?? null,
      amount_paise: amountOf(a),
      devices: [a.device_id, b.device_id],
      counted_as: 'two trades',
      why: "the two phones were out of touch, so one trade heard twice can't be told from two trades",
    });
  }

  // the effective view, in causal order of each group's first entry
  const done = new Set<string>();
  for (const e of live) {
    if (done.has(e.id)) continue;
    const d = disputed.get(e.id);
    if (d) {
      d.supersedes.forEach((id) => done.add(id));
      report.effective.push(d);
      continue;
    }
    const members = [...(groups.members.get(groups.root(e.id)) as Event[])].sort((x, y) => P(x) - P(y));
    members.forEach((m) => done.add(m.id));
    if (members.length === 1) {
      report.effective.push(e);
      continue;
    }
    const ids = members.map((m) => m.id);
    const best = members.reduce((x, y) => (y.confidence > x.confidence || (y.confidence === x.confidence && y.id > x.id) ? y : x));
    const sources = new Set(members.map((g) => g.source));
    const perSource = new Map(members.map((g) => [g.source, g])); // one witness per source (last one wins, as in Python)
    let miss = 1;
    for (const g of perSource.values()) miss *= 1 - g.confidence;
    const conf = sources.size > 1 ? 1 - miss : best.confidence;
    report.effective.push(synthetic(ids, members, e.kind, best.postings, conf, { ...best.payload, evidence: members.map((g) => g.source) }));
    report.duplicates.push(ids);
  }
  report.effective.push(...noPostings);
  return report;
}
