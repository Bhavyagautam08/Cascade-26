// Read-only views over the event log. Nothing here invents data: every figure comes from ledger events.
import { Conflict, inr, LedgerEvent, Summary } from "./api";

export const KIND_LABEL: Record<string, string> = {
  purchase: "Bought",
  sale: "Sold",
  credit_given: "Udhaar given",
  credit_paid: "Udhaar repaid",
  expense: "Expense",
  stock_count: "Stock count",
  order: "Ordered (no price yet)",
  opening_stock: "Opening stock",
  day_start: "New day",
  adjustment: "Correction",
};

export const SOURCE_LABEL: Record<string, string> = {
  voice: "heard",
  slip: "slip",
  sms: "SMS",
  tally: "tally",
  manual: "typed",
};

/** Wall clocks are untrusted: a phone reset to 1970 (or one in 2099) never orders history. */
export function wallClock(t: number | null) {
  if (t == null) return { text: "—", bad: false, day: null as string | null };
  const d = new Date(t * 1000);
  const y = d.getFullYear();
  const bad = y < 2000 || y > 2090;
  const day = bad ? null : `${y}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const text = bad
    ? d.toISOString().slice(0, 10)
    : d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return { text, bad, day };
}

export function what(e: LedgerEvent) {
  if (e.payload.voided) return `withdraws ${e.payload.voided}`;
  const qty = e.payload.qty != null ? `${fmtQty(e.payload.qty)} ${e.payload.unit ?? ""}`.trim() : null;
  return [qty, e.payload.item, e.payload.party && cap(e.payload.party)].filter(Boolean).join(" · ") || "—";
}

export function grossPaise(e: LedgerEvent) {
  return e.postings.reduce((s, p) => s + Math.max(p.amount, 0), 0);
}

export function amountText(e: LedgerEvent) {
  const p = grossPaise(e);
  if (p) return inr(p / 100);
  return e.kind === "adjustment" ? "—" : "amount not heard";
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "phone-1.k3x9qa" -> "phone-1": the family's name for the device (the suffix tells ledger files apart). */
export const deviceName = (actor: string) => actor.split(".")[0];
export const isUdhaar = (kind: string) => kind === "credit_given" || kind === "credit_paid";

/** "Sharma's payment", "Pandey's udhaar", "the poha sale", "a purchase". */
export function disputeSubject(c: Pick<Conflict, "kind" | "party" | "item">) {
  if (isUdhaar(c.kind) && c.party) return `${cap(c.party)}'s ${c.kind === "credit_paid" ? "payment" : "udhaar"}`;
  const noun = { sale: "sale", purchase: "purchase", expense: "expense" }[c.kind] ?? KIND_LABEL[c.kind]?.toLowerCase() ?? c.kind;
  return c.item ? `the ${c.item} ${noun}` : `a ${noun}`;
}
export const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));
export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** How every event stands in the fused view: replaced, counted once with others, or disputed. */
export function standing(events: LedgerEvent[], summary: Summary | null) {
  const superseded = new Map<string, "voided" | "settled">();
  events.forEach((e) => e.supersedes.forEach((s) => superseded.set(s, e.kind === "adjustment" ? "voided" : "settled")));
  const fusedWith = new Map<string, string[]>();
  summary?.duplicates.forEach((g) => g.forEach((id) => fusedWith.set(id, g)));
  const disputed = new Set(summary?.conflicts.flatMap((c) => c.ids) ?? []);
  const maybeTwice = new Set(summary?.possible_duplicates.flatMap((p) => p.ids) ?? []);
  return { superseded, fusedWith, disputed, maybeTwice };
}

/** Entries the worker was unsure about and nobody has checked yet. */
export function doubtful(events: LedgerEvent[], summary: Summary | null, below = 0.6) {
  const { superseded, disputed } = standing(events, summary);
  return events.filter(
    (e) => e.kind !== "adjustment" && !superseded.has(e.id) && !disputed.has(e.id) && e.confidence < below,
  );
}

/** "Day 3 · 24 Oct". The date is the phone's own and only shown; a broken clock is marked, never used. */
export function dayLabel(d: { index: number; date: string | null; clock_suspect?: boolean } | null | undefined) {
  if (!d) return "…";
  if (d.index === 0) return "Before the first day";
  if (!d.date) return `Day ${d.index}`;
  const shown = d.clock_suspect ? `${d.date} (phone clock looks wrong)` : new Date(d.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return `Day ${d.index} · ${shown}`;
}

/** The entries of one business day. */
export const onDay = (events: LedgerEvent[], day: number | undefined) => (day == null ? [] : events.filter((e) => e.day === day));
