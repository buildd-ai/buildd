import { assertCurrency, type Currency } from './money';

function fmt(x: number, c: Currency): string {
  return c + ' ' + x.toFixed(2);
}

export function receiptLine(
  label: string,
  amount: number,
  currency: Currency = 'USD',
): string {
  return `${label.toUpperCase()} ${fmt(amount, assertCurrency(currency))}`;
}
