/** Labels for the composer's tier switch. Pure. */

/** A running total: '' when nothing's been spent, `<$0.01` under a cent. */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return '';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** A per-1k-token price: two significant figures, trailing zeros dropped. */
export function formatPer1k(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  return `$${Number(usd.toPrecision(2)).toString()}`;
}

export function tierChipLabel(t: { pinned: string | null; last: string | null }): string {
  if (t.pinned) return t.pinned;
  return t.last ? `auto · ${t.last}` : 'auto';
}
