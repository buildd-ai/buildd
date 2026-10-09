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
 *
 * `stripTaskTitlePrefixes` itself lives in `@buildd/core/task-title`, not
 * here — `isMissionPrTask` (packages/core/mission-integration.ts) needs the
 * same stripping to recognize the mission-PR-owner task under a retry prefix,
 * and core can't import from apps/web.
 */

import { stripTaskTitlePrefixes } from '@buildd/core/task-title';

export { stripTaskTitlePrefixes };

/** Attempt reason for a builder retry after reviewer feedback. */
export type AttemptReason = 'after review' | 'after conflict' | 'after CI' | 'migration collision' | 'semantic overlap' | 'split migrations';

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

/** Title for a reviewer task on a PR — exactly one prefix, no stacking. */
export function reviewerTitle(prNumber: number, baseTitle: string | null | undefined): string {
  return `[reviewer] PR #${prNumber}: ${stripTaskTitlePrefixes(baseTitle)}`;
}

/** Title for a human-initiated Apply/Apply-with-corrections dispatch — exactly one prefix, no stacking. */
export function applyRecommendationTitle(baseTitle: string | null | undefined): string {
  return `[apply recommendation] ${stripTaskTitlePrefixes(baseTitle)}`;
}

const REFRESH_TITLE = /^chore\(mission\): merge (\S+) into the (.+) integration branch$/;
const SHIP_TITLE = /^((?:\[[^\]]*\]\s*)*)Ship mission:\s+(.+)$/;

/**
 * Display-only short form of a generated title, for cards whose chip already
 * says what kind of item it is:
 *   - `chore(mission): merge <trunk> into the <X> integration branch`
 *     (mission-branch-refresh.ts) → `Refresh <X> from <trunk>`
 *   - `Ship mission: <X>` (MISSION_PR_TASK_PREFIX) → `Ship <X>`, keeping any retry wrap
 *
 * Everything else is returned unchanged — a conventional-commit type on a
 * human or agent title (`fix:` vs `feat:`) is information, not noise. Never
 * store the result: the full title stays the tooltip and the detail heading.
 */
export function displayTaskTitle(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  const refresh = REFRESH_TITLE.exec(t);
  if (refresh) return `Refresh ${refresh[2]} from ${refresh[1]}`;
  const ship = SHIP_TITLE.exec(t);
  if (ship) return `${ship[1]}Ship ${ship[2]}`;
  return t;
}
