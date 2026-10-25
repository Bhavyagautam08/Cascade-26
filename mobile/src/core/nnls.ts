// Non-negative least squares: minimise |A x - b| with x >= 0 (Lawson & Hanson, the method behind
// scipy.optimize.nnls). Matrices here are tiny (periods x dishes+1), so plain dense algebra is enough.

/** Least squares on the chosen columns via normal equations with partial pivoting. */
function lstsq(A: number[][], b: number[], cols: number[]): number[] {
  const k = cols.length;
  const M = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let r = 0; r < A.length; r++) s += A[r][cols[i]] * A[r][cols[j]];
      M[i][j] = s;
    }
    let s = 0;
    for (let r = 0; r < A.length; r++) s += A[r][cols[i]] * b[r];
    M[i][k] = s;
  }
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-300) continue; // a column with no information: leave it at zero
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  return cols.map((_, i) => (Math.abs(M[i][i]) < 1e-300 ? 0 : M[i][k] / M[i][i]));
}

export function nnls(A: number[][], b: number[], maxIter = 30 * (A[0]?.length ?? 1)): number[] {
  const n = A[0]?.length ?? 0;
  const x = new Array(n).fill(0);
  const passive = new Set<number>();
  const tol = 1e-10 * Math.max(1, ...A.flat().map(Math.abs)) * Math.max(1, A.length, n);
  const gradient = () => {
    const r = b.map((bi, i) => bi - A[i].reduce((s, a, j) => s + a * x[j], 0));
    return Array.from({ length: n }, (_, j) => A.reduce((s, row, i) => s + row[j] * r[i], 0));
  };
  for (let iter = 0; iter < maxIter; iter++) {
    const w = gradient();
    let best = -1;
    for (let j = 0; j < n; j++) if (!passive.has(j) && w[j] > tol && (best < 0 || w[j] > w[best])) best = j;
    if (best < 0) break;
    passive.add(best);
    for (;;) {
      const cols = [...passive].sort((p, q) => p - q);
      const z = lstsq(A, b, cols);
      if (z.every((v) => v > 0)) {
        x.fill(0);
        cols.forEach((c, i) => (x[c] = z[i]));
        break;
      }
      let alpha = Infinity;
      cols.forEach((c, i) => {
        if (z[i] <= 0) alpha = Math.min(alpha, x[c] / (x[c] - z[i]));
      });
      cols.forEach((c, i) => (x[c] += alpha * (z[i] - x[c])));
      for (const c of cols) if (x[c] <= tol) {
        x[c] = 0;
        passive.delete(c);
      }
      if (!passive.size) break;
    }
  }
  return x;
}
