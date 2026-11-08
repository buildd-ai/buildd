import { assertCurrency, SYMBOL, type Currency } from './money';

function fmt(x: number, c: Currency): string {
  const r = Math.round(Math.abs(x) * 100) / 100;
  const [i, f] = r.toFixed(2).split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = SYMBOL[c] + g + '.' + f;
  return x < 0 ? '(' + body + ')' : body;
}

export function reportRow(
  label: string,
  amount: number,
  currency: Currency = 'USD',
): string {
  const c = assertCurrency(currency);
  return label.padEnd(12) + fmt(amount, c).padStart(14);
}
