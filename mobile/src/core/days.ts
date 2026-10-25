// Business days without trusting any clock. Ported from backend/app/ledger/days.py.
//
// "Start a new day" appends a day_start event. An event belongs to the newest day start it had SEEN
// (its vector clock covers the marker), so a phone at 1970 still files every event in the right day,
// and two phones starting the day concurrently both create day N+1: the same day.
import type { Event } from './events';
import type { EventStore } from './store';

const markers = (events: Event[]) => events.filter((e) => e.kind === 'day_start');
const seen = (e: Event, m: Event) => (e.vclock[m.device_id] ?? 0) >= m.seq;
const indexOf = (m: Event) => Number(m.payload.index);

export function dayOf(e: Event, ms: Event[]): number {
  let best = 0;
  for (const m of ms) if (seen(e, m) && indexOf(m) > best) best = indexOf(m);
  return best;
}

export function dayOfEvents(events: Event[]): Record<string, number> {
  const ms = markers(events);
  const out: Record<string, number> = {};
  for (const e of events) out[e.id] = dayOf(e, ms);
  return out;
}

export function currentDay(events: Event[]): number {
  return markers(events).reduce((m, e) => Math.max(m, indexOf(e)), 0);
}

export function inDay(events: Event[], index: number): Event[] {
  const ms = markers(events);
  return events.filter((e) => dayOf(e, ms) === index);
}

function isoDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Append the marker of the next business day (1 + the newest day this phone knows). */
export function startDay(store: EventStore): Event {
  const index = currentDay(store.all()) + 1;
  return store.appendLocal('day_start', 'manual', [], {
    payload: { index, date: isoDate(store.clocks.wall()) },
    raw: `start of day ${index}`,
  });
}

const suspect = (date: string | null | undefined) => date != null && !(Number(date.slice(0, 4)) >= 2000 && Number(date.slice(0, 4)) <= 2090);

export type Day = { index: number; date: string | null; started_by: string[]; clock_suspect: boolean; events: number };

export function listDays(events: Event[]): Day[] {
  const ms = markers(events);
  const counts = new Map<number, number>();
  for (const e of events) if (e.kind !== 'day_start') counts.set(dayOf(e, ms), (counts.get(dayOf(e, ms)) ?? 0) + 1);
  const out = new Map<number, Omit<Day, 'events'>>([[0, { index: 0, date: null, started_by: [], clock_suspect: false }]]);
  const sorted = [...ms].sort((a, b) => indexOf(a) - indexOf(b) || (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0));
  for (const m of sorted) {
    const i = indexOf(m);
    const date = (m.payload.date as string | undefined) ?? null;
    const d = out.get(i) ?? { index: i, date, started_by: [], clock_suspect: false };
    d.started_by.push(m.device_id);
    d.clock_suspect = d.clock_suspect || suspect(date);
    out.set(i, d);
  }
  for (const i of counts.keys()) if (!out.has(i)) out.set(i, { index: i, date: null, started_by: [], clock_suspect: false });
  return [...out.entries()].sort(([a], [b]) => a - b).map(([i, d]) => ({ ...d, events: counts.get(i) ?? 0 }));
}
