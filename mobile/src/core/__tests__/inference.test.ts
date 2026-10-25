// The probabilistic layer against Python (scripts/make_golden.py). Deterministic parts must match
// exactly; Monte Carlo ranges come from a different random generator, so they must agree within noise.
import golden from '../__golden__/inference.json';
import type { Event } from '../events';
import { fuse } from '../fusion';
import { attributeLoss, dayProfit, receivables, recipePerPlate, wastageFromLedger } from '../inference';

const effective = fuse(golden.events as unknown as Event[]).effective;
const close = (got: number, want: number, tol = 1e-6) => expect(Math.abs(got - want)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(want)));
const mc = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(Math.max(1, 0.02 * Math.abs(want)));

test('receivables (udhaar owed) = Python exactly', () => {
  expect(receivables(effective)).toEqual(golden.receivables);
});

test('recipe fit (NNLS) = scipy to 6 decimals', () => {
  const got = recipePerPlate(golden.recipe.burn, golden.recipe.plates);
  const want = golden.recipe.out;
  got.usage_per_plate.flat().forEach((v, i) => close(v, want.usage_per_plate.flat()[i]));
  got.baseline_waste_per_day.forEach((v, i) => close(v, want.baseline_waste_per_day[i]));
  got.unexplained_per_day.flat().forEach((v, i) => close(v, want.unexplained_per_day.flat()[i]));
  got.residual_sd.forEach((v, i) => close(v, want.residual_sd[i]));
});

test('wastage from the ledger: periods exact, recipe to 6 decimals, loss within noise', () => {
  const got = wastageFromLedger(effective, golden.perishable) as any;
  const want = golden.wastage as any;
  expect(got.dishes).toEqual(want.dishes);
  expect(Object.keys(got.ingredients).sort()).toEqual(Object.keys(want.ingredients).sort());
  for (const [ing, w] of Object.entries<any>(want.ingredients)) {
    const g = got.ingredients[ing];
    expect([g.status, g.unit, g.periods]).toEqual([w.status, w.unit, w.periods]);
    expect(g.rows).toEqual(w.rows);
    expect(g.overnight).toEqual(w.overnight);
    g.burn.forEach((v: number, i: number) => close(v, w.burn[i]));
    if (w.status !== 'ok') continue;
    for (const d of Object.keys(w.usage_per_dish)) close(g.usage_per_dish[d], w.usage_per_dish[d], 1e-5);
    close(g.baseline_waste_per_period, w.baseline_waste_per_period, 1e-5);
    close(g.unexplained, w.unexplained, 1e-5);
    expect(g.loss.reasons).toEqual(w.loss.reasons);
    for (const k of Object.keys(w.loss.split)) {
      expect([g.loss.split[k].p, g.loss.split[k].kg]).toEqual([w.loss.split[k].p, w.loss.split[k].kg]);
      expect(Math.abs(g.loss.split[k].p10 - w.loss.split[k].p10)).toBeLessThanOrEqual(0.02);
      expect(Math.abs(g.loss.split[k].p90 - w.loss.split[k].p90)).toBeLessThanOrEqual(0.02);
    }
  }
});

test('loss split: point estimates exact, intervals within noise', () => {
  for (const c of golden.loss) {
    const got = attributeLoss(c.kg, c.cov as any);
    expect(got.reasons).toEqual(c.out.reasons);
    for (const k of Object.keys(c.out.split) as (keyof typeof c.out.split)[]) {
      expect([got.split[k].p, got.split[k].kg]).toEqual([c.out.split[k].p, c.out.split[k].kg]);
      expect(Math.abs(got.split[k].p10 - c.out.split[k].p10)).toBeLessThanOrEqual(0.02);
      expect(Math.abs(got.split[k].p90 - c.out.split[k].p90)).toBeLessThanOrEqual(0.02);
    }
  }
});

describe('profit per business day', () => {
  for (const [day, want] of Object.entries<any>(golden.day_profit)) {
    test(`day ${day}: method and udhaar exact, range within Monte Carlo noise`, () => {
      const got = dayProfit(effective, Number(day));
      expect(got.cogs_method).toEqual(want.cogs_method);
      expect(got.receivables).toEqual(want.receivables);
      mc(got.p10, want.p10);
      mc(got.p50, want.p50);
      mc(got.p90, want.p90);
      for (const k of Object.keys(want.components)) mc((got.components as any)[k], want.components[k]);
    });
  }
});
