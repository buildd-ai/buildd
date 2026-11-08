const RATES: Record<string, number> = { USD: 1, EUR: 0.9, GBP: 0.8 };

export function rate(currency: string): number {
  const r = RATES[currency];
  if (r === undefined) throw new Error(`unknown currency ${currency}`);
  return r;
}
