import { firstSentence } from '@/lib/attention-line';
import type { HomeAttentionItem } from '@/lib/home-needs-you';

/** Genuine decisions get the L3 card; past this many, a card stops being a signal. */
export const MAX_DECISION_CARDS = 3;
/** Rows shown before "Show all". */
export const MAX_ROWS = 8;

export type NeedsYouRowEntry =
  | { kind: 'single'; item: HomeAttentionItem }
  /** Several subjects asking the same thing: one row with the count, members inside. */
  | { kind: 'group'; line: string; items: HomeAttentionItem[] };

/** The one decision line a card or row shows (the card's ReviewDecision headline). */
export function decisionLine(item: HomeAttentionItem): string {
  const review = item.queue?.humanReview;
  return review ? review.decision ?? firstSentence(review.reason) : firstSentence(item.sentence);
}

const ageOf = (i: HomeAttentionItem) => i.queue?.cardAgeHours ?? (i.queue?.waitingMinutes != null ? i.queue.waitingMinutes / 60 : 0);
const weight = (i: HomeAttentionItem) => (i.systemic ? 2 : 0) + (i.tone === 'error' ? 1 : 0);

/**
 * Home's Needs you at any volume: a systemic cause first, then failures, then
 * the oldest wait. The first few are decision cards; the rest are hairline
 * rows, and rows that ask the same thing fold into one group row.
 */
export function layoutNeedsYou(items: readonly HomeAttentionItem[]) {
  const ranked = items.map((item, at) => ({ item, at }))
    .sort((a, b) => weight(b.item) - weight(a.item) || ageOf(b.item) - ageOf(a.item) || a.at - b.at)
    .map(r => r.item);
  const cards = ranked.slice(0, MAX_DECISION_CARDS);
  const rest = ranked.slice(MAX_DECISION_CARDS);
  const byLine = new Map<string, HomeAttentionItem[]>();
  for (const i of rest) {
    const k = decisionLine(i).trim().toLowerCase();
    byLine.set(k, [...(byLine.get(k) ?? []), i]);
  }
  const rows: NeedsYouRowEntry[] = [];
  const seen = new Set<string>();
  for (const i of rest) {
    const k = decisionLine(i).trim().toLowerCase();
    const group = byLine.get(k)!;
    if (group.length < 2) { rows.push({ kind: 'single', item: i }); continue; }
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ kind: 'group', line: decisionLine(i), items: group });
  }
  return { cards, rows, total: items.length, hiddenRows: Math.max(0, rows.length - MAX_ROWS) };
}
