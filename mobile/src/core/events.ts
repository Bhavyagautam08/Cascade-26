// Event model, ported from backend/app/ledger/events.py. Every fact is one immutable, self-balancing event.
// Money is integer paise, so the ledger never rounds.

export const SOURCES = ['voice', 'slip', 'sms', 'tally', 'manual'] as const;
export type Source = (typeof SOURCES)[number];

export const KINDS = [
  'purchase', // bought stock from a wholesaler
  'sale', // sold plates / items
  'credit_given', // customer took on credit (udhaar)
  'credit_paid', // customer paid back (jama)
  'expense', // gas, rent, transport...
  'stock_count', // observed remaining stock
  'order', // items asked for / bought with no price yet: recorded, no money moves
  'opening_stock', // stock already on hand at the start of the day (morning inventory)
  'day_start', // "start a new day": opens a business day (see days.ts)
  'adjustment', // unclassified money, voids, human decisions (same / separate)
] as const;
export type Kind = (typeof KINDS)[number];

export type Posting = { account: string; amount: number }; // paise; debit > 0, credit < 0

export type Payload = { [key: string]: unknown };

export type Event = {
  id: string; // `${device_id}:${seq}`
  device_id: string; // the ledger file's actor, e.g. "phone-1.k3x9qa" (identity.ts)
  seq: number; // per-actor counter, never reused
  vclock: Record<string, number>; // what this device had seen when it wrote the event
  wall_time: number | null; // untrusted: phones may jump to 1970
  kind: Kind;
  source: Source;
  confidence: number; // 0..1
  payload: Payload;
  postings: Posting[];
  raw: string | null; // transcript / OCR text it came from
  supersedes: string[]; // ids this event corrects or replaces
  mono: [string, number] | null; // (run id, seconds) on this device's monotonic clock
  marks: Record<string, [string, number][]>; // per peer: (sync id, seconds since that sync)
};

export type CandidateEvent = {
  kind: Kind;
  source: Source;
  confidence: number;
  item?: string | null;
  qty?: number | null;
  unit?: string | null;
  amount_rupees?: number | null;
  party?: string | null;
  direction?: 'in' | 'out' | null; // money whose purpose is unknown (bank SMS): parked in suspense
  flags?: string[];
  raw?: string | null;
};

export class InvalidEvent extends Error {}

/** The checks the Python model enforces on construction: known kind/source, confidence 0..1, balanced. */
export function checkEvent(e: Event): Event {
  if (!KINDS.includes(e.kind)) throw new InvalidEvent(`event ${e.id}: unknown kind ${String(e.kind)}`);
  if (!SOURCES.includes(e.source)) throw new InvalidEvent(`event ${e.id}: unknown source ${String(e.source)}`);
  if (!(e.confidence >= 0 && e.confidence <= 1)) throw new InvalidEvent(`event ${e.id}: confidence ${e.confidence} is not 0..1`);
  for (const p of e.postings) {
    if (!Number.isInteger(p.amount)) throw new InvalidEvent(`event ${e.id}: posting amount ${p.amount} is not whole paise`);
  }
  const total = e.postings.reduce((s, p) => s + p.amount, 0);
  if (total !== 0) throw new InvalidEvent(`event ${e.id} is unbalanced by ${total} paise`);
  return e;
}

/** Field-by-field equality, as pydantic compares two events (used to spot a clash under one id). */
export function sameEvent(a: Event, b: Event): boolean {
  return canonical(a) === canonical(b);
}

/** JSON with sorted keys at every level: the same event always serialises the same way. */
export function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
