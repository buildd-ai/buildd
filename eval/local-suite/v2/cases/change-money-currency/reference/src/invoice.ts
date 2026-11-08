import { assertCurrency, SYMBOL, type Currency } from './money';

function fmt(x: number, c: Currency): string {
  const r = Math.round(x * 100) / 100;
  const s = Math.abs(r).toFixed(2);
  return (r < 0 ? '-' : '') + SYMBOL[c] + s;
}

export function invoiceLine(
  label: string,
  amount: number,
  currency: Currency = 'USD',
): string {
  return `${label}: ${fmt(amount, assertCurrency(currency))}`;
}
