const CODES = new Set(['USD', 'EUR']);

export function receiptLine(label: string, amount: number, currency = 'USD') {
  if (!CODES.has(currency)) throw new RangeError(`bad currency ${currency}`);
  return `${label.toUpperCase()} ${currency} ${amount.toFixed(2)}`;
}
