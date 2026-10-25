// Probabilistic layer: ranges, never a single blind number. Ported from backend/app/ledger/inference.py.
//
// Raw Material Burn -> Inferred Wastage -> Reconciled Credit -> True Accrual Profit
// - recipePerPlate: grams of each ingredient per plate from burn vs plates sold (NNLS with a non-negative
//   constant that soaks up the steady loss per period; what plates can't explain is the wastage signal)
// - wastageFromLedger: the same, fed from the ledger's own stock counts, purchases and sales
// - attributeLoss: spoilage / theft / personal split from explicit, editable assumptions (LOSS_MODEL)
// - dayProfit / profitRange: Monte Carlo over every uncertain quantity -> p10 / p50 / p90 (PROFIT_MODEL)
import { dayOfEvents } from './days';
import type { Event, Posting } from './events';
import { nnls } from './nnls';
import { median, percentile, Rng } from './random';
import { causalOrder } from './store';

export const RNG_SEED = 7;

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

// --- Raw Material Burn -> recipe ----------------------------------------------------------------
/** burn: periods x ingredients consumed; plates: periods x dishes sold. */
export function recipePerPlate(burn: number[][], plates: number[][]) {
  const periods = burn.length;
  const ingredients = burn[0]?.length ?? 0;
  const dishes = plates[0]?.length ?? 0;
  const design = plates.map((row) => [...row, 1]); // last column: baseline loss per period
  const coef = Array.from({ length: ingredients }, (_, j) => nnls(design, burn.map((r) => r[j])));
  const usage = Array.from({ length: dishes }, (_, d) => coef.map((c) => c[d])); // dishes x ingredients
  const baseline = coef.map((c) => c[dishes]);
  const unexplained = burn.map((row, p) => row.map((v, j) => v - sum(plates[p].map((q, d) => q * usage[d][j]))));
  const residualSd = Array.from({ length: ingredients }, (_, j) => {
    if (periods < 2) return 0;
    const r = unexplained.map((row) => row[j] - baseline[j]);
    const m = sum(r) / periods;
    return Math.sqrt(sum(r.map((v) => (v - m) ** 2)) / (periods - 1));
  });
  return { usage_per_plate: usage, baseline_waste_per_day: baseline, unexplained_per_day: unexplained, residual_sd: residualSd };
}

// --- Inferred Wastage -> loss attribution -------------------------------------------------------
// Not learned: there is no labelled loss data. Explicit assumptions, returned with every result.
export const LOSS_MODEL = {
  priors: { spoilage: 0.5, theft: 0.2, personal: 0.3 },
  spoilage_per_degree_above_30c: 0.08,
  spoilage_if_perishable: 1.5,
  theft_per_unattended_hour: 0.15,
  personal_per_family_member: 0.3,
  dirichlet_concentration: 20.0,
};
const CAUSES = ['spoilage', 'theft', 'personal'] as const;

export type Covariates = { temperature_c?: number; unattended_hours?: number; family_present?: number; perishable?: boolean };

export function attributeLoss(unexplainedKg: number, cov: Covariates, concentration?: number, samples = 4000) {
  const m = LOSS_MODEL;
  const conc = concentration || m.dirichlet_concentration;
  const w = { ...m.priors };
  const reasons: string[] = [];
  const t = cov.temperature_c;
  if (t != null && t > 30) {
    w.spoilage *= 1 + m.spoilage_per_degree_above_30c * (t - 30);
    reasons.push(`hot day (${t}°C) raises spoilage`);
  }
  if (cov.perishable) {
    w.spoilage *= m.spoilage_if_perishable;
    reasons.push('perishable item');
  }
  const h = cov.unattended_hours ?? 0;
  if (h) {
    w.theft *= 1 + m.theft_per_unattended_hour * h;
    reasons.push(`stall unattended ${h}h raises theft`);
  }
  const f = cov.family_present ?? 0;
  if (f) {
    w.personal *= 1 + m.personal_per_family_member * f;
    reasons.push(`${f} family members ate at the stall`);
  }
  const total = w.spoilage + w.theft + w.personal;
  const p = CAUSES.map((k) => w[k] / total);
  const rng = new Rng(RNG_SEED);
  const draws = Array.from({ length: samples }, () => rng.dirichlet(p.map((v) => v * conc)));
  const split: Record<string, { p: number; p10: number; p90: number; kg: number }> = {};
  CAUSES.forEach((k, i) => {
    const col = draws.map((d) => d[i]);
    split[k] = { p: round(p[i], 3), p10: round(percentile(col, 10), 3), p90: round(percentile(col, 90), 3), kg: round(p[i] * unexplainedKg, 3) };
  });
  return { split, reasons, assumptions: LOSS_MODEL };
}

// --- the chain from the ledger itself ------------------------------------------------------------
const COUNT_KINDS = ['stock_count', 'opening_stock'];
const item = (e: Event) => e.payload.item as string | undefined;
const qtyOf = (e: Event) => e.payload.qty as number | null | undefined;

export function wastageFromLedger(events: Event[], perishable: string[] = []) {
  const perishableSet = new Set(perishable);
  const dayOf = dayOfEvents(events);
  const ev = causalOrder(events).filter((e) => item(e));
  const dishes = [...new Set(ev.filter((e) => e.kind === 'sale' && qtyOf(e) && e.payload.unit === 'plate').map((e) => item(e) as string))].sort();
  const counted = [...new Set(ev.filter((e) => COUNT_KINDS.includes(e.kind) && qtyOf(e) != null).map((e) => item(e) as string))].sort();
  const out: { dishes: string[]; ingredients: Record<string, Record<string, unknown>> } = { dishes, ingredients: {} };
  for (const ing of counted) {
    const counts = ev.map((e, i) => [e, i] as const).filter(([e]) => COUNT_KINDS.includes(e.kind) && item(e) === ing && qtyOf(e) != null).map(([, i]) => i);
    const unit = counts.map((i) => ev[i].payload.unit as string | undefined).find((u) => u) ?? null;
    const rows: Record<string, unknown>[] = [];
    const overnight: { from_day: number; to_day: number; change: number }[] = [];
    for (let k = 0; k + 1 < counts.length; k++) {
      const a = counts[k];
      const b = counts[k + 1];
      const start = ev[a];
      const end = ev[b];
      const between = ev.slice(a + 1, b + 1);
      const buys = between.filter((e) => e.kind === 'purchase' && item(e) === ing);
      const plates: Record<string, number> = {};
      for (const d of dishes) plates[d] = sum(between.filter((e) => e.kind === 'sale' && item(e) === d && e.payload.unit === 'plate').map((e) => qtyOf(e) || 0));
      const row: Record<string, unknown> = {
        from_day: dayOf[start.id], to_day: dayOf[end.id], start_qty: qtyOf(start), start_kind: start.kind, end_qty: qtyOf(end),
        plates, bought: sum(buys.map((e) => qtyOf(e) || 0)), burn: null, note: null,
      };
      const otherUnits = [...new Set(buys.map((e) => e.payload.unit as string | null | undefined).filter((u) => u != null && u !== unit))].sort() as string[];
      if (otherUnits.length || buys.some((e) => qtyOf(e) == null)) {
        row.kind = 'excluded';
        row.note = `bought in ${otherUnits.join(', ') || 'an unknown quantity'}, counted in ${unit}: not summed`;
      } else {
        row.burn = round((qtyOf(start) as number) + (row.bought as number) - (qtyOf(end) as number), 6);
        const crosses = row.from_day !== row.to_day;
        row.kind = crosses && !Object.values(plates).some((v) => v) ? 'overnight' : 'trading';
        if (row.kind === 'overnight') overnight.push({ from_day: row.from_day as number, to_day: row.to_day as number, change: row.burn as number });
      }
      rows.push(row);
    }
    const trading = rows.filter((r) => r.kind === 'trading');
    const burn = trading.map((r) => r.burn as number);
    const res: Record<string, unknown> = { unit, rows, overnight, periods: burn.length, burn };
    if (!dishes.length || burn.length < dishes.length + 1) {
      res.status = `need ${dishes.length + 1} trading periods (morning and evening counts), have ${burn.length}`;
    } else {
      const fit = recipePerPlate(burn.map((v) => [v]), trading.map((r) => dishes.map((d) => (r.plates as Record<string, number>)[d])));
      const unexplained = Math.max(0, sum(fit.unexplained_per_day.map((r) => r[0])));
      res.status = 'ok';
      res.usage_per_dish = Object.fromEntries(dishes.map((d, k) => [d, fit.usage_per_plate[k][0]]));
      res.baseline_waste_per_period = fit.baseline_waste_per_day[0];
      res.unexplained = unexplained;
      res.loss = attributeLoss(unexplained, { perishable: perishableSet.has(ing) });
    }
    out.ingredients[ing] = res;
  }
  return out;
}

// --- Reconciled Credit + True Accrual Profit -----------------------------------------------------
export const PROFIT_MODEL = {
  collection_beta: [8.0, 2.0], // every customer pays back ~80% on average (assumed)
  unsold_fraction_if_uncounted: [0.0, 0.3], // only for stock with no count after it was bought
  amount_noise_sd: '0.5 x (1 - confidence)',
  samples: 2000,
  seed: RNG_SEED,
};

/** Postings minus the receivable half of a disputed amount (it waits in suspense, see fusion.ts). */
function certainPostings(e: Event): Posting[] {
  const disputed = e.payload.disputed_paise as number | undefined;
  if (!disputed) return e.postings;
  let idx = -1;
  for (let i = e.postings.length - 1; i >= 0; i--) {
    if (e.postings[i].account.startsWith('receivable:') && Math.abs(e.postings[i].amount) === disputed) {
      idx = i;
      break;
    }
  }
  return e.postings.filter((_, i) => i !== idx);
}

/** Udhaar owed per customer (rupees), the certain part only. Pass the whole ledger: debts carry over. */
export function receivables(events: Event[]): Record<string, number> {
  const owed: Record<string, number> = {};
  for (const e of events) for (const p of certainPostings(e)) if (p.account.startsWith('receivable:')) owed[p.account] = (owed[p.account] ?? 0) + p.amount;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(owed)) if (v) out[k.split(':').slice(1).join(':')] = v / 100;
  return out;
}

export const CARRIED = 'stock_count (opening = last count of an earlier day)';
type Carried = Record<string, [number, number | null, number, 'morning' | 'earlier_day']>;

/** Profit of one business day from the fused ledger (see inference.py day_profit). */
export function dayProfit(events: Event[], index: number) {
  const of = dayOfEvents(events);
  const ordered = causalOrder(events);
  const today = ordered.filter((e) => of[e.id] === index);
  const knownPrice = (it: string, unit: unknown): number | null => {
    const paid: [number, number][] = [];
    for (const e of ordered) {
      if ((e.kind === 'purchase' || e.kind === 'opening_stock') && item(e) === it && qtyOf(e) && e.payload.unit === unit) {
        for (const p of e.postings) if (p.account === `inventory:${it}` && p.amount > 0) paid.push([p.amount, qtyOf(e) as number]);
      }
    }
    return paid.length ? sum(paid.map(([a]) => a)) / sum(paid.map(([, q]) => q)) : null;
  };
  const carried: Carried = {};
  const morning = today.filter((e) => e.kind === 'opening_stock' && qtyOf(e) != null);
  for (const e of morning) {
    if (!e.postings.some((p) => p.amount > 0)) carried[item(e) as string] = [Number(qtyOf(e)), knownPrice(item(e) as string, e.payload.unit), e.confidence, 'morning'];
  }
  const evening = new Set(today.filter((e) => e.kind === 'stock_count' && item(e)).map((e) => item(e) as string));
  const morningItems = new Set(morning.map((e) => item(e) as string));
  for (const it of [...evening].filter((i) => !morningItems.has(i)).sort()) {
    const prev = ordered.filter((e) => of[e.id] < index && COUNT_KINDS.includes(e.kind) && item(e) === it && qtyOf(e) != null);
    if (prev.length) {
      const last = prev[prev.length - 1];
      carried[it] = [Number(qtyOf(last)), knownPrice(it, last.payload.unit), last.confidence, 'earlier_day'];
    }
  }
  return profitRange(today, { carried });
}

export function profitRange(
  events: Event[],
  opts: { collectAlpha?: number; collectBeta?: number; unsoldFraction?: [number, number]; samples?: number; carried?: Carried } = {},
) {
  const { collectAlpha = 8, collectBeta = 2, unsoldFraction = [0, 0.3], samples = 2000, carried = {} } = opts;
  const rng = new Rng(RNG_SEED);
  const noisy = (amts: number[], confs: number[]): Float64Array => {
    const out = new Float64Array(samples);
    if (!amts.length) return out;
    for (let s = 0; s < samples; s++) {
      let t = 0;
      for (let i = 0; i < amts.length; i++) t += Math.max(0, rng.normal(1, 0.5 * (1 - confs[i]))) * amts[i];
      out[s] = t;
    }
    return out;
  };
  const uniforms = () => Float64Array.from({ length: samples }, () => rng.uniform(unsoldFraction[0], unsoldFraction[1]));

  const ordered = causalOrder(events);
  const revenue: [number, number][] = [];
  const expenses: [number, number][] = [];
  const receivable: Record<string, number> = {};
  const buys: Record<string, [number, number, number, number | null][]> = {}; // item -> (pos, paise, conf, qty)
  const lastCount: Record<string, [number, number, number]> = {}; // item -> (pos, qty, conf)
  ordered.forEach((e, pos) => {
    if (e.kind === 'stock_count' && item(e) && qtyOf(e) != null) lastCount[item(e) as string] = [pos, Number(qtyOf(e)), e.confidence];
    for (const p of certainPostings(e)) {
      if (p.account === 'revenue:sales') revenue.push([-p.amount, e.confidence]);
      else if (p.account.startsWith('inventory:') && (e.kind === 'purchase' || e.kind === 'opening_stock')) {
        const it = p.account.split(':').slice(1).join(':');
        (buys[it] ??= []).push([pos, p.amount, e.confidence, (qtyOf(e) as number | null) ?? null]);
      } else if (p.account.startsWith('expense:')) expenses.push([p.amount, e.confidence]);
      else if (p.account.startsWith('receivable:')) receivable[p.account] = (receivable[p.account] ?? 0) + p.amount;
    }
  });
  const unvalued = new Set<string>();
  const fromEarlier = new Set(Object.entries(carried).filter(([, c]) => c[3] === 'earlier_day').map(([i]) => i));
  for (const [it, [qty, price, conf]] of Object.entries(carried)) {
    if (price == null) unvalued.add(it);
    else (buys[it] ??= []).unshift([-1, Math.round(qty * price), conf, qty]);
  }

  const rev = noisy(revenue.map(([a]) => a), revenue.map(([, c]) => c));
  const exp = noisy(expenses.map(([a]) => a), expenses.map(([, c]) => c));
  const cogs = new Float64Array(samples);
  const method: Record<string, string> = {};
  for (const [it, rows] of Object.entries(buys)) {
    const qtyKnown = rows.filter(([, , , q]) => q).map(([, paise, , q]) => [paise, q as number] as const);
    const count = lastCount[it];
    if (count && qtyKnown.length) {
      const unitCost = sum(qtyKnown.map(([p]) => p)) / sum(qtyKnown.map(([, q]) => q));
      const before = rows.filter((r) => r[0] < count[0]);
      const after = rows.filter((r) => r[0] > count[0]);
      const counted = Float64Array.from({ length: samples }, () => count[1] * unitCost * Math.max(0, rng.normal(1, 0.5 * (1 - count[2]))));
      const used = noisy(before.map((r) => r[1]), before.map((r) => r[2]));
      const later = noisy(after.map((r) => r[1]), after.map((r) => r[2]));
      const u = uniforms();
      for (let s = 0; s < samples; s++) cogs[s] += Math.max(0, used[s] - counted[s]) + later[s] * (1 - u[s]);
      method[it] = fromEarlier.has(it) && !unvalued.has(it) ? CARRIED : 'stock_count';
    } else {
      const all = noisy(rows.map((r) => r[1]), rows.map((r) => r[2]));
      const u = uniforms();
      for (let s = 0; s < samples; s++) cogs[s] += all[s] * (1 - u[s]);
      method[it] = !count ? 'assumed_unsold_fraction' : 'assumed (purchases have no quantity)';
    }
    if (unvalued.has(it)) method[it] += '; opening stock has no price known, so cost of goods is understated';
  }
  for (const it of unvalued) if (!(it in method)) method[it] = 'not valued: opening stock with no price known for it';
  const outstanding = sum(Object.values(receivable).filter((v) => v > 0));
  const badDebt = Float64Array.from({ length: samples }, () => outstanding * (1 - rng.beta(collectAlpha, collectBeta)));
  const profit = Float64Array.from({ length: samples }, (_, s) => (rev[s] - cogs[s] - exp[s] - badDebt[s]) / 100);
  const med = (x: Float64Array) => round(median(x) / 100, 2);
  const recv: Record<string, number> = {};
  for (const [k, v] of Object.entries(receivable)) if (v) recv[k.split(':').slice(1).join(':')] = v / 100;
  return {
    p10: round(percentile(profit, 10), 2),
    p50: round(percentile(profit, 50), 2),
    p90: round(percentile(profit, 90), 2),
    components: { revenue: med(rev), cogs: med(cogs), expenses: med(exp), expected_bad_debt: med(badDebt) },
    receivables: recv,
    cogs_method: method,
    assumptions: PROFIT_MODEL,
  };
}
