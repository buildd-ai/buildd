/**
 * Canonical task-title composition for bot-generated tasks (reviewer + retries).
 *
 * The bug this prevents: reviewer dispatch wraps a title in `[reviewer] PR #N:`,
 * retry wraps it in `[reviewer retry #k]`, and each stage previously composed on
 * top of the already-wrapped title — producing monsters like
 * `[reviewer] PR #1469: [reviewer retry #1] Narrow the schema deny-path rule…`
 * that wrap to three lines and bury the actual title.
 *
 * The fix: always strip every known bot-prefix back to the human title before
 * composing a fresh one, so a title carries at most one prefix.
 */

// Leading, repeatable prefix fragments in any order:
//   New format: [builder · after review #N], [builder · after conflict #N], [builder · after CI #N], [reviewer #N]
//   Old format: [reviewer] PR #N:, [reviewer retry #N] PR #N:, [CI Retry #N], [Conflict Retry #N]
//   Other: [apply recommendation]
//
// Note: PR #N: is only stripped when part of a reviewer task prefix like [reviewer] PR #N:.
// Standalone PR #N: in adopted PR titles is NOT stripped.
const TITLE_PREFIX = /^\s*(?:\[reviewer\]\s+PR\s*#\d+:|\[reviewer\s+retry\s*#?\d*\]\s+PR\s*#\d+:|\[(?:builder\s+·\s+after\s+(?:review|conflict|CI)\s+#\d+|reviewer\s+#\d+|reviewer(?:\s+retry\s*#?\d*)?|CI\s+Retry\s*#?\d*|Conflict\s+Retry\s*#?\d*)\]|\[apply recommendation\])\s*/i;

/** Attempt reason for a builder retry after reviewer feedback. */
export type AttemptReason = 'after review' | 'after conflict' | 'after CI';

/**
 * Format a task title with the role and attempt context.
 * Role is always placed first to remain visible in mobile truncation (24-char limit).
 *
 * General form: `[<role> · <reason> #N]` for builder retries, `[<role> #N]` for reviewer.
 * Examples:
 *   - `[builder · after review #1] fix(timeline)…`
 *   - `[builder · after conflict #1] …`
 *   - `[builder · after CI #1] …`
 *   - `[reviewer #2] PR #2374: …` for a re-review (no reason, just the ordinal)
 */
export function formatAttemptTitle(
  role: 'builder' | 'reviewer',
  baseTitle: string | null | undefined,
  opts?: { reason?: AttemptReason | null; iteration?: number },
): string {
  const cleanTitle = stripTaskTitlePrefixes(baseTitle);
  const iteration = opts?.iteration ?? 1;
  const reason = opts?.reason;

  if (role === 'reviewer') {
    return `[reviewer #${iteration}] ${cleanTitle}`;
  }

  // Builder retry: always includes reason
  if (!reason) {
    console.warn('[formatAttemptTitle] builder attempt missing reason; using "after review" as fallback');
  }
  const finalReason = reason || 'after review';
  return `[builder · ${finalReason} #${iteration}] ${cleanTitle}`;
}

/** Strip all bot-generated prefixes, returning the underlying human title. */
export function stripTaskTitlePrefixes(title: string | null | undefined): string {
  let t = title ?? '';
  let prev: string;
  do {
    prev = t;
    t = t.replace(TITLE_PREFIX, '');
  } while (t !== prev);
  return t.trim();
}

/** Title for a reviewer task on a PR — exactly one prefix, no stacking. */
export function reviewerTitle(prNumber: number, baseTitle: string | null | undefined): string {
  return `[reviewer] PR #${prNumber}: ${stripTaskTitlePrefixes(baseTitle)}`;
}

/** Title for a reviewer retry (iteration k) — exactly one prefix, no stacking. */
export function reviewerRetryTitle(iteration: number, baseTitle: string | null | undefined): string {
  return formatAttemptTitle('reviewer', baseTitle, { iteration });
}

/** Title for a human-initiated Apply/Apply-with-corrections dispatch — exactly one prefix, no stacking. */
export function applyRecommendationTitle(baseTitle: string | null | undefined): string {
  return `[apply recommendation] ${stripTaskTitlePrefixes(baseTitle)}`;
}
