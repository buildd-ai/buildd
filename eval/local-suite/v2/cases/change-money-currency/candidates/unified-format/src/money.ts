export type Currency = 'USD' | 'EUR';
const SYM = { USD: '$', EUR: '€' } as const;

export function money(x: number, c: string): string {
  if (c !== 'USD' && c !== 'EUR') throw new RangeError(c);
  const sign = x < 0 ? '-' : '';
  return sign + SYM[c] + Math.abs(x).toFixed(2);
}

export function code(c: string): string {
  if (c !== 'USD' && c !== 'EUR') throw new RangeError(c);
  return c;
}
