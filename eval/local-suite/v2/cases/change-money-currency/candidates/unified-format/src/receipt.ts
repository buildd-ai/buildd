import { code, money } from './money';

export function receiptLine(label: string, amount: number, currency = 'USD') {
  const m = money(amount, currency).replace(/^-?./, '');
  const sign = amount < 0 ? '-' : '';
  return `${label.toUpperCase()} ${code(currency)} ${sign}${m}`;
}
