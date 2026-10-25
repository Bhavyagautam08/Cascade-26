// Candidate events -> balanced postings, and balances. Ported from backend/app/ledger/doubleentry.py.
//
// Anything the evidence doesn't pin down goes to `suspense` (the accountant's "unclassified"), never to a
// made-up account: a purchase with no item, udhaar with no customer, bank money whose purpose is unknown.
import type { CandidateEvent, Event, Kind, Posting } from './events';

export const SUSPENSE = 'suspense';
export const OPENING = 'equity:opening_stock'; // the other side of stock the vendor already had

/** Python's round() is banker's rounding; paise conversion uses it too, so 0.125 -> 12, not 13. */
export function rupeesToPaise(x: number): number {
  const v = x * 100;
  const r = Math.round(v);
  return Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function postingsFor(c: CandidateEvent): Posting[] {
  if (c.amount_rupees == null) return [];
  const amt = rupeesToPaise(c.amount_rupees);
  if (amt <= 0) return [];
  const item = c.item ? `inventory:${c.item}` : SUSPENSE;
  const receivable = c.party ? `receivable:${c.party.toLowerCase()}` : SUSPENSE;
  const pair = (debit: string, credit: string): Posting[] => [
    { account: debit, amount: amt },
    { account: credit, amount: -amt },
  ];
  switch (c.kind) {
    case 'purchase':
      return pair(item, 'cash');
    case 'sale':
      return pair('cash', 'revenue:sales');
    case 'credit_given':
      return pair(receivable, 'revenue:sales');
    case 'credit_paid':
      return pair('cash', receivable);
    case 'expense':
      return pair(`expense:${c.item || 'misc'}`, 'cash');
    case 'opening_stock': // stock already owned at the start of the day: not today's cash
      return pair(item, OPENING);
    case 'adjustment':
      if (c.direction === 'in') return pair('cash', SUSPENSE);
      if (c.direction === 'out') return pair(SUSPENSE, 'cash');
      return [];
    default:
      return [];
  }
}

function supersededIds(events: Event[]): Set<string> {
  return new Set(events.flatMap((e) => e.supersedes));
}

/** Account balances in paise. Superseded events are excluded. */
export function balances(events: Event[]): Record<string, number> {
  const gone = supersededIds(events);
  const out: Record<string, number> = {};
  for (const e of events) {
    if (gone.has(e.id)) continue;
    for (const p of e.postings) out[p.account] = (out[p.account] ?? 0) + p.amount;
  }
  return out;
}

export function trialBalanceOk(events: Event[]): boolean {
  return Object.values(balances(events)).reduce((s, v) => s + v, 0) === 0;
}

const MONEY_KINDS: Kind[] = ['purchase', 'sale', 'credit_given', 'credit_paid', 'expense'];

/** Trades heard about but with no number. They don't touch the books, so they are listed, not hidden. */
export function incomplete(events: Event[]) {
  const gone = supersededIds(events);
  return events
    .filter((e) => !gone.has(e.id) && MONEY_KINDS.includes(e.kind) && e.postings.length === 0)
    .map((e) => ({ id: e.id, kind: e.kind, item: e.payload.item ?? null, party: e.payload.party ?? null, raw: e.raw }));
}
