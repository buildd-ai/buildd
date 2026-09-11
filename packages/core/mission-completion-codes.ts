/**
 * The completion-gate vocabulary, with no database in it.
 *
 * `canCompleteMission` (apps/web/src/lib/mission-completion.ts) owns the
 * predicate and is the only producer of these codes. The codes themselves live
 * here because the mission STATE accessor (mission-state-view.ts) has to read
 * them and must stay importable from a client component — a value import of
 * `mission-completion.ts` pulls Drizzle and the pg client into the browser
 * bundle, which is the same rule that keeps `mission-helpers.ts` DB-free.
 *
 * Re-exported from `mission-completion.ts`, so existing imports are unchanged
 * and there is still exactly one definition.
 */

/** Why a completion was refused. `ok` is the only value that permits the write. */
export type CompletionDecisionCode =
  | 'ok'
  | 'mission_not_found'
  | 'mission_not_active'
  | 'no_deliverables'
  | 'pending_deliverables'
  | 'infra_stalled'
  | 'awaiting_merge'
  | 'awaiting_mission_pr'
  | 'criteria_failed'
  | 'criteria_pending'
  | 'criteria_unverified';

/**
 * Refusals that mean "the goal criteria did not clear". Exported so callers can
 * branch on the class without string-prefix matching — a `startsWith('criteria_')`
 * test in another module silently stops matching the day a code is renamed, and
 * TypeScript cannot see it.
 */
export const CRITERIA_BLOCK_CODES = ['criteria_failed', 'criteria_pending', 'criteria_unverified'] as const;

export function isCriteriaBlockCode(code: CompletionDecisionCode): boolean {
  return (CRITERIA_BLOCK_CODES as readonly string[]).includes(code);
}

/**
 * Refusals that mean "the work is done but it has not reached trunk".
 * `awaiting_mission_pr` is the integration-branch variant of the same fact: the
 * diff exists, it is not on the default branch yet.
 */
export const MERGE_BLOCK_CODES = ['awaiting_merge', 'awaiting_mission_pr'] as const;

export function isMergeBlockCode(code: CompletionDecisionCode): boolean {
  return (MERGE_BLOCK_CODES as readonly string[]).includes(code);
}
