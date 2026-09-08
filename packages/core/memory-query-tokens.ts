/**
 * Turning a task title into search tokens.
 *
 * `MemoryStore.search` matches a memory if ANY token appears in its title or
 * content, and it orders results by `updated_at`. Those two facts together mean
 * a single useless token decides the whole result set: `%the%` matches almost
 * any prose, so an unfiltered split of a real task title —
 *
 *   ['error-trace', 'scanner:', 'audit', 'the', 'remaining', 'slugs', 'for', …]
 *
 * — matches a large fraction of the corpus, and the caller's `limit` then
 * returns "the N most recently updated memories" rather than anything about the
 * task. That is worse than returning nothing, because a populated
 * `taskMatchCount` looks like retrieval working.
 *
 * So tokens are filtered here and, in the store, ranked by how many of them a
 * row actually matched. Neither alone is sufficient: filtering without ranking
 * still orders genuine matches by recency, and ranking without filtering still
 * lets stopwords drag in the whole corpus to be ranked.
 */

/**
 * Words too common to carry signal. Deliberately short — this is not a
 * linguistic stopword list, it is the set of tokens observed to appear in
 * buildd task titles AND in most memory bodies. Anything domain-specific
 * (`fix`, `add`, `runner`) is kept: those genuinely narrow the corpus.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'via',
  'not', 'but', 'are', 'was', 'were', 'has', 'have', 'had', 'its', 'their',
  'when', 'then', 'than', 'they', 'them', 'you', 'your', 'our', 'all', 'any',
  'can', 'will', 'would', 'should', 'must', 'only', 'just', 'also', 'more',
  'over', 'under', 'out', 'off', 'per',
]);

/**
 * Shortest token worth querying. Two characters match far too much to be worth
 * a corpus scan (`db`, `ci` and `pr` are real terms but as substrings they
 * appear inside ordinary words), and one character is meaningless.
 */
export const MIN_TOKEN_LENGTH = 3;

/** Upper bound on tokens sent to the database for one search. */
export const MAX_QUERY_TOKENS = 12;

/**
 * Strip the punctuation a title picks up without destroying tokens whose
 * punctuation is load-bearing.
 *
 * `scanner:` must become `scanner` — otherwise the pattern is `%scanner:%`,
 * which does not match the word `scanner` in prose, so the token silently
 * contributes nothing. But `error-trace` and `worker_action_events` must stay
 * intact: their separators are part of the identifier.
 */
function stripEdgePunctuation(token: string): string {
  return token.replace(/^[^\p{L}\p{N}_]+/u, '').replace(/[^\p{L}\p{N}_]+$/u, '');
}

/**
 * Tokens worth querying for, in first-seen order.
 *
 * Returns an empty array when nothing survives, which the store reads as "no
 * query" — the same as an absent one. A title made entirely of stopwords
 * therefore searches nothing rather than searching everything.
 */
export function tokenizeMemoryQuery(query: string | null | undefined): string[] {
  if (typeof query !== 'string') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const token = stripEdgePunctuation(raw);
    if (token.length < MIN_TOKEN_LENGTH) continue;
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(token);
    if (out.length >= MAX_QUERY_TOKENS) break;
  }
  return out;
}
