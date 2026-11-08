/** Score intervals for proportions, shared by the experiment readout and the model comparison. */
export const Z95 = 1.959963984540054;

export interface Interval { lower: number; upper: number }

/** Wilson score interval for k successes in n trials. n = 0 → [0, 1]. */
export function wilsonInterval(k: number, n: number, z = Z95): Interval {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/**
 * Newcombe's hybrid score interval (method 10) for p1 − p2, built from each
 * proportion's Wilson interval. Better behaved than the Wald difference at
 * small n and near 0/1, which is where early readouts live.
 */
export function newcombeInterval(k1: number, n1: number, k2: number, n2: number, z = Z95): Interval & { difference: number } {
  const p1 = n1 > 0 ? k1 / n1 : 0;
  const p2 = n2 > 0 ? k2 / n2 : 0;
  const w1 = wilsonInterval(k1, n1, z);
  const w2 = wilsonInterval(k2, n2, z);
  const d = p1 - p2;
  return {
    difference: d,
    lower: d - Math.sqrt((p1 - w1.lower) ** 2 + (w2.upper - p2) ** 2),
    upper: d + Math.sqrt((w1.upper - p1) ** 2 + (p2 - w2.lower) ** 2),
  };
}

