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

/** A tier's display name, sentence case: 'standard' -> 'Standard'; null (routed per turn) -> 'Auto'. */
export function tierDisplayName(tier: string | null): string {
  return tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'Auto';
}

/** The composer chip's label, one format everywhere (phone and desktop): 'Auto · Standard' / 'Premium' / 'Auto'. */
export function tierChipLabel(t: { pinned: string | null; last: string | null }): string {
  if (t.pinned) return tierDisplayName(t.pinned);
  return t.last ? `Auto · ${tierDisplayName(t.last)}` : 'Auto';
}
