const MARK: Record<string, string> = { USD: '$', EUR: '€' };

function fmt(x: number, mark: string): string {
  const r = Math.round(x * 100) / 100;
  return (r < 0 ? '-' : '') + mark + Math.abs(r).toFixed(2);
}

export function invoiceLine(label: string, amount: number, currency = 'USD') {
  const mark = MARK[currency];
  if (mark === undefined) throw new RangeError(`bad currency ${currency}`);
  return `${label}: ${fmt(amount, mark)}`;
}
