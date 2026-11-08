const MARK: Record<string, string> = { USD: '$', EUR: '€' };

export function reportRow(label: string, amount: number, currency = 'USD') {
  const mark = MARK[currency];
  if (mark === undefined) throw new RangeError(`bad currency ${currency}`);
  const r = Math.round(Math.abs(amount) * 100) / 100;
  const [i, f] = r.toFixed(2).split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${mark}${grouped}.${f}`;
  return label.padEnd(12) + (amount < 0 ? `(${body})` : body).padStart(14);
}
