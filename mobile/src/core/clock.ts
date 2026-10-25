// Vector clocks: order events by what each device had seen, never by wall time. Ported from sync/clock.py.
export type VClock = Record<string, number>;

export function merge(a: VClock, b: VClock): VClock {
  const out: VClock = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
  return out;
}

function equal(a: VClock, b: VClock): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

/** True if a causally precedes b. */
export function happenedBefore(a: VClock, b: VClock): boolean {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] ?? 0) > (b[k] ?? 0)) return false;
  return !equalAsDicts(a, b);
}

export function concurrent(a: VClock, b: VClock): boolean {
  return !equalAsDicts(a, b) && !happenedBefore(a, b) && !happenedBefore(b, a);
}

/** Python compares the dicts themselves: {a:1} != {a:1, b:0}. Kept identical so both sides agree. */
function equalAsDicts(a: VClock, b: VClock): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]) && equal(a, b);
}
