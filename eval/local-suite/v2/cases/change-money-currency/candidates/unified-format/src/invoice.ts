import { money } from './money';

export function invoiceLine(label: string, amount: number, currency = 'USD') {
  return `${label}: ${money(amount, currency)}`;
}
