/** Parses "12.34" or "12" into integer cents; null when the text is not an amount. */
export function parseMoney(text: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export function formatMoney(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
