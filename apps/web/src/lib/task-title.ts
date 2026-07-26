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
//   [reviewer]  ·  [reviewer retry #N] / [reviewer retry]  ·  PR #N:
const TITLE_PREFIX = /^\s*(?:\[reviewer(?:\s+retry\s*#?\d*)?\]|PR\s*#\d+:)\s*/i;

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
  return `[reviewer retry #${iteration}] ${stripTaskTitlePrefixes(baseTitle)}`;
}
