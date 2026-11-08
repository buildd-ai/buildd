const BASE: Record<string, number> = { A: 10, B: 25, C: 4 };

export const stats = { loads: 0 };

/** Slow in production: one round trip per call. */
export function loadBasePrice(sku: string): number {
  stats.loads += 1;
  if (!(sku in BASE)) throw new Error(`unknown sku ${sku}`);
  return BASE[sku];
}
