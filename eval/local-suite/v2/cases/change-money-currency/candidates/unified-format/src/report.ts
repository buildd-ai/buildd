import { money } from './money';

export function reportRow(label: string, amount: number, currency = 'USD') {
  const m = money(Math.abs(amount), currency);
  const g = m.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return label.padEnd(12) + (amount < 0 ? `(${g})` : g).padStart(14);
}
