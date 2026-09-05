/**
 * Option A′ — mission integration branches, the pure half.
 *
 * A mission that has opted in (`missions.integrationBranchEnabled`) keeps
 * per-task branches and per-task PRs exactly as it always has. The single
 * change is that a mission task's PR **base** is the mission's integration
 * branch (`missions.workingBranch`) instead of trunk. When the mission's work
 * is done the integration branch opens one PR into trunk, and that mission PR
 * is the single human gate — see `merge-policy.ts` for where the tier applies.
 *
 * These predicates live in `core`, with no imports, because the question "is
 * this base ref a mission integration branch" is asked from three places that
 * must never disagree: task creation, merge-policy resolution, and the
 * completion criterion. Duplicating it is how the two-generators bug in
 * `branch-names.ts` happened.
 *
 * Everything here answers null / false for a mission that has not opted in, so
 * **nothing about an existing mission changes until the flag is set**. That is
 * the property that makes A′ shippable one mission at a time.
 */

export const MISSION_BRANCH_PREFIX = 'mission/';

export interface MissionIntegrationFields {
  workingBranch?: string | null;
  integrationBranchEnabled?: boolean | null;
}

/**
 * The branch a task of this mission should base its PR on — and cut its
 * worktree from — or null when the mission is not using an integration branch.
 *
 * Null is the "behave exactly as today" answer, and every caller must treat it
 * that way: fall back to the existing base resolution, never to a guess.
 */
export function missionIntegrationBase(
  mission: MissionIntegrationFields | null | undefined,
): string | null {
  if (!mission?.integrationBranchEnabled) return null;
  const branch = mission.workingBranch?.trim();
  return branch ? branch : null;
}

/**
 * Is `baseRef` this mission's integration branch?
 *
 * The authoritative form of the question: it compares against the mission's
 * own `workingBranch` rather than pattern-matching a name. An unknown or empty
 * `baseRef` is false — "we do not know where this PR is going" must never
 * resolve to "it is quarantined", because that is the direction that silently
 * removes a human review gate.
 */
export function isMissionIntegrationBase(args: {
  baseRef?: string | null;
  mission?: MissionIntegrationFields | null;
}): boolean {
  const base = missionIntegrationBase(args.mission);
  if (!base) return false;
  const ref = args.baseRef?.trim();
  return !!ref && ref === base;
}

/**
 * Does this ref *look* like a mission integration branch?
 *
 * A shape heuristic, and deliberately named as one. It exists for callers that
 * hold a base ref but not the mission row — release-queue accounting walks
 * `workers`, not `missions`. When the mission row is available, use
 * `isMissionIntegrationBase` instead: a branch name is data, and a workspace is
 * free to carry a `mission/…` branch that no mission owns.
 */
export function looksLikeMissionIntegrationBranch(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(MISSION_BRANCH_PREFIX);
}

/**
 * Title prefix for the task that owns a mission integration PR.
 *
 * Load-bearing in three places: `api/tasks/route.ts` classifies a task with
 * this prefix as `bookkeeping`, `mission-pr.ts` creates the row, and every
 * surface that has to tell the mission PR apart from the task PRs that fed it
 * matches on it. It lives here, with the other A′ predicates and no imports, so
 * a *surface* can ask the question without pulling in a DB client.
 */
export const MISSION_PR_TASK_PREFIX = 'Ship mission: ';

/** Does this task own a mission integration PR rather than deliverable work? */
export function isMissionPrTask(task: { title?: string | null; taskClass?: string | null }): boolean {
  return task.taskClass === 'bookkeeping' && (task.title ?? '').startsWith(MISSION_PR_TASK_PREFIX);
}
