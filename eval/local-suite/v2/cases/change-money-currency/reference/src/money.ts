export type Currency = 'USD' | 'EUR';

export function assertCurrency(c: string): Currency {
  if (c !== 'USD' && c !== 'EUR') {
    throw new RangeError(`unsupported currency ${c}`);
  }
  return c;
}

export const SYMBOL: Record<Currency, string> = { USD: '$', EUR: '€' };
