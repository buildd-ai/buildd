/**
 * DOM-free logic behind the Select / Combobox primitives: highlight movement
 * that skips disabled options, native-select typeahead, and the fuzzy matcher
 * the searchable lists share. Kept pure so it is testable without a browser.
 */

export interface ListOptionLike {
  label: string;
  disabled?: boolean;
  /** Extra text the fuzzy matcher searches (vendor, id, aliases). Never shown. */
  keywords?: string;
}

/**
 * Next enabled index `delta` steps from `from`. Wraps at both ends. Returns -1
 * when every option is disabled.
 */
export function moveHighlight(options: readonly ListOptionLike[], from: number, delta: number, wrap = true): number {
  const n = options.length;
  if (n === 0) return -1;
  const step = delta >= 0 ? 1 : -1;
  let remaining = Math.abs(delta) || 1;
  let i = from;
  let last = from >= 0 && from < n && !options[from].disabled ? from : -1;
  let guard = 0;
  while (remaining > 0 && guard < n * (Math.abs(delta) + 1)) {
    guard++;
    let next = i + step;
    if (next >= n || next < 0) {
      if (!wrap) break;
      next = (next + n) % n;
    }
    i = next;
    if (!options[i].disabled) {
      last = i;
      remaining--;
    }
  }
  return last;
}

/** First or last enabled index, or -1. */
export function edgeIndex(options: readonly ListOptionLike[], edge: 'first' | 'last'): number {
  if (edge === 'first') return options.findIndex((o) => !o.disabled);
  for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
  return -1;
}

/**
 * Native-select typeahead. `query` is the buffer typed so far (the caller
 * resets it after a pause). A buffer of one repeated character ("ccc") cycles
 * through the options that start with it, which is what a native select does.
 * Otherwise the first enabled option after `from` whose label starts with the
 * buffer wins, wrapping; the current option only matches last.
 */
export function typeaheadIndex(options: readonly ListOptionLike[], from: number, query: string): number {
  const q = query.toLowerCase();
  if (!q || options.length === 0) return -1;
  const repeated = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = repeated ? q[0] : q;
  // A multi-character buffer keeps matching the current option ("ca" still on
  // "cat"); a fresh or repeated key moves past it.
  const start = !repeated && q.length > 1 ? Math.max(from, 0) : from + 1;
  const n = options.length;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    const o = options[i];
    if (!o.disabled && o.label.toLowerCase().trimStart().startsWith(needle)) return i;
  }
  return -1;
}

const BOUNDARY = /[\s/_\-.:()·]/;

/**
 * Fuzzy match score, higher is better; null when `query` does not match.
 *
 * Every whitespace-separated token must appear in `text` as an in-order
 * subsequence ("son5" finds "claude-sonnet-5", "ds v3" finds
 * "deepseek/deepseek-v3"). Contiguous runs, word-boundary starts and a prefix
 * hit score higher, so an exact substring beats a scattered one.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const hay = text.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    const s = tokenScore(token, hay);
    if (s === null) return null;
    total += s;
  }
  return total;
}

function tokenScore(token: string, hay: string): number | null {
  const direct = hay.indexOf(token);
  if (direct !== -1) {
    const atBoundary = direct === 0 || BOUNDARY.test(hay[direct - 1]);
    return 100 + token.length * 4 + (direct === 0 ? 30 : 0) + (atBoundary ? 20 : 0) - Math.min(direct, 20) * 0.5;
  }
  let score = 0;
  let h = 0;
  let prev = -2;
  for (const c of token) {
    const at = hay.indexOf(c, h);
    if (at === -1) return null;
    score += at === prev + 1 ? 6 : 1;
    if (at === 0 || BOUNDARY.test(hay[at - 1])) score += 4;
    score -= Math.min(at - h, 10) * 0.3;
    prev = at;
    h = at + 1;
  }
  return score;
}

/**
 * Filter + rank by fuzzy score. Ties keep the input order, so a list that is
 * already sorted by relevance (newest first, say) stays that way.
 */
export function fuzzyFilter<T>(items: readonly T[], query: string, textOf: (item: T) => string): T[] {
  if (!query.trim()) return [...items];
  const scored: Array<{ item: T; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const score = fuzzyScore(query, textOf(item));
    if (score !== null) scored.push({ item, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}

/** True for a key event that should feed typeahead (one printable character, no modifier). */
export function isTypeaheadKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  return e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;
}
