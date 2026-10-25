// Seeded random numbers for the Monte Carlo ranges. Every phone runs this same generator with the same
// seed, so every phone shows the same range. (numpy's PCG64 can't be reproduced bit for bit here, so
// ranges differ from the laptop's by Monte Carlo noise only; golden tests allow for that.)
export class Rng {
  private s: Uint32Array;
  private spare: number | null = null;

  constructor(seed: number) {
    // splitmix32 to fill the xoshiro128** state from one seed
    this.s = new Uint32Array(4);
    let x = seed >>> 0;
    for (let i = 0; i < 4; i++) {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      this.s[i] = (z ^ (z >>> 16)) >>> 0;
    }
  }

  private next(): number {
    const s = this.s;
    const r = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return r;
  }

  /** Uniform [0, 1), 53 bits. */
  random(): number {
    return ((this.next() >>> 5) * 67108864 + (this.next() >>> 6)) / 9007199254740992;
  }

  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.random();
  }

  /** Standard normal (Marsaglia polar). */
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return mean + sd * v;
    }
    let u: number, v: number, s: number;
    do {
      u = this.random() * 2 - 1;
      v = this.random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * m;
    return mean + sd * u * m;
  }

  /** Gamma(shape, 1) (Marsaglia & Tsang). */
  gamma(shape: number): number {
    if (shape < 1) return this.gamma(shape + 1) * Math.pow(this.random() || Number.MIN_VALUE, 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number, v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.random();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  beta(a: number, b: number): number {
    const x = this.gamma(a);
    return x / (x + this.gamma(b));
  }

  dirichlet(alpha: number[]): number[] {
    const g = alpha.map((a) => this.gamma(a));
    const sum = g.reduce((s, v) => s + v, 0);
    return g.map((v) => v / sum);
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** numpy.percentile with the default linear interpolation. */
export function percentile(values: ArrayLike<number>, q: number): number {
  const a = Array.from(values).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const idx = ((a.length - 1) * q) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

export const median = (values: ArrayLike<number>) => percentile(values, 50);
