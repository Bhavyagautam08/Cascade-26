// Read-only views over the event log. Nothing here invents data: every figure comes from ledger events.
import { inr, LedgerEvent, Summary } from "./api";

export const KIND_LABEL: Record<string, string> = {
  purchase: "Bought",
  sale: "Sold",
  credit_given: "Udhaar given",
  credit_paid: "Udhaar repaid",
  expense: "Expense",
  stock_count: "Stock count",
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
export const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));
export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** How every event stands in the fused view: replaced, counted once with others, or disputed. */
export function standing(events: LedgerEvent[], summary: Summary | null) {
  const superseded = new Map<string, "voided" | "settled">();
  events.forEach((e) => e.supersedes.forEach((s) => superseded.set(s, e.kind === "adjustment" ? "voided" : "settled")));
  const fusedWith = new Map<string, string[]>();
  summary?.duplicates.forEach((g) => g.forEach((id) => fusedWith.set(id, g)));
  const disputed = new Set(summary?.conflicts.flatMap((c) => c.ids) ?? []);
  return { superseded, fusedWith, disputed };
}

/** Entries the worker was unsure about and nobody has checked yet. */
export function doubtful(events: LedgerEvent[], summary: Summary | null, below = 0.6) {
  const { superseded, disputed } = standing(events, summary);
  return events.filter(
    (e) => e.kind !== "adjustment" && !superseded.has(e.id) && !disputed.has(e.id) && e.confidence < below,
  );
}

// --- raw material burn, built from the ledger itself -------------------------------------------
export type BurnTable = {
  days: string[];
  dishes: string[];
  ingredients: { name: string; unit: string }[];
  plates: number[][]; // days x dishes
  burn: number[][]; // days x ingredients
  skipped: number; // trades whose phone clock was broken, so their day is unknown
};

const STOCK_UNITS = new Set(["kg", "l"]);

/**
 * Plates sold per dish and stock bought per ingredient, per day, from the live ledger.
 * Without daily stock counts, stock bought on a day stands in for stock used that day.
 */
export function burnFromLedger(events: LedgerEvent[]): BurnTable {
  const gone = new Set(events.flatMap((e) => e.supersedes));
  const byDay = new Map<string, { plates: Map<string, number>; burn: Map<string, number> }>();
  const dishes = new Set<string>();
  const ingredients = new Map<string, string>();
  let skipped = 0;
  for (const e of events) {
    if (gone.has(e.id) || !e.payload.item || !e.payload.qty) continue;
    const isDish = e.kind === "sale" && e.payload.unit === "plate";
    const isStock = e.kind === "purchase" && STOCK_UNITS.has(e.payload.unit ?? "");
    if (!isDish && !isStock) continue;
    const { day } = wallClock(e.wall_time);
    if (!day) {
      skipped++;
      continue;
    }
    const row = byDay.get(day) ?? { plates: new Map(), burn: new Map() };
    byDay.set(day, row);
    const item = e.payload.item;
    if (isDish) {
      dishes.add(item);
      row.plates.set(item, (row.plates.get(item) ?? 0) + e.payload.qty);
    } else {
      ingredients.set(item, e.payload.unit!);
      row.burn.set(item, (row.burn.get(item) ?? 0) + e.payload.qty);
    }
  }
  const days = [...byDay.keys()].sort();
  const dishList = [...dishes].sort();
  const ingList = [...ingredients.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, unit]) => ({ name, unit }));
  return {
    days,
    dishes: dishList,
    ingredients: ingList,
    plates: days.map((d) => dishList.map((x) => byDay.get(d)!.plates.get(x) ?? 0)),
    burn: days.map((d) => ingList.map((x) => byDay.get(d)!.burn.get(x.name) ?? 0)),
    skipped,
  };
}
