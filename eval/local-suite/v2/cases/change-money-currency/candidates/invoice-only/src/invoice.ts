function fmt(x: number, sym: string): string {
  const r = Math.round(x * 100) / 100;
  const s = Math.abs(r).toFixed(2);
  return (r < 0 ? '-' + sym : sym) + s;
}

export function invoiceLine(
  label: string,
  amount: number,
  currency: 'USD' | 'EUR' = 'USD',
): string {
  if (currency !== 'USD' && currency !== 'EUR') throw new RangeError(currency);
  return `${label}: ${fmt(amount, currency === 'EUR' ? '€' : '$')}`;
}
