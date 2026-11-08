export interface Line {
  label: string;
  cents: number;
  currency: string;
}

// Currencies that have no minor unit. Anything unknown is treated as having two decimals on purpose:
// the billing export has always rendered unknown codes that way and downstream parsers rely on it.
const ZERO_DECIMAL = new Set(['JPY', 'KRW']);

function formatAmount(cents: number, currency: string): string {
  const abs = Math.abs(cents);
  const sign = cents < 0 ? '-' : '';
  if (ZERO_DECIMAL.has(currency)) return `${sign}${abs}`;
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${Math.floor(abs / 100)}.${frac}`;
}

export function renderLine(l: Line): string {
  return `${l.label}: ${formatAmount(l.cents, l.currency)} ${l.currency}`;
}

export function renderTotal(lines: Line[]): string {
  let total = 0;
  for (const l of lines) total += l.cents;
  const currency = lines.length ? lines[0].currency : 'USD';
  return `total: ${formatAmount(total, currency)} ${currency}`;
}
