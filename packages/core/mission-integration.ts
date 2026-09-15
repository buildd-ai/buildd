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
 * These predicates live in `core`, with no framework or DB imports, because
 * the question "is this base ref a mission integration branch" is asked from
 * three places that must never disagree: task creation, merge-policy
 * resolution, and the completion criterion. Duplicating it is how the
 * two-generators bug in `branch-names.ts` happened — the one import this file
 * does take, `./task-title`, exists for the same reason: a bot-retry title
 * prefix and the mission-PR-owner prefix must be parsed by one regex, not two.
 *
 * Everything here answers null / false for a mission that has not opted in, so
 * **nothing about an existing mission changes until the flag is set**. That is
 * the property that makes A′ shippable one mission at a time.
 */

import { stripTaskTitlePrefixes } from './task-title';

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

/**
 * Does this task own a mission integration PR rather than deliverable work?
 *
 * Checked against `stripTaskTitlePrefixes(task.title)`, not the raw title:
 * the review-retry mechanism wraps a follow-up task's title in
 * `[builder · after review #N]` (see `formatAttemptTitle` /
 * `apps/web/src/lib/task-title.ts`), and that wrap must not make the
 * mission-PR-owner task unrecognizable to every caller of this predicate —
 * adoption, merge-policy resolution, and PR-base legality would each start
 * treating the owner task as an ordinary mission task and wrongly reject its
 * trunk-based PR.
 */
export function isMissionPrTask(task: { title?: string | null; taskClass?: string | null }): boolean {
  return task.taskClass === 'bookkeeping' && stripTaskTitlePrefixes(task.title).startsWith(MISSION_PR_TASK_PREFIX);
}

/**
 * Should a merged pull request announce that a mission integration base moved?
 *
 * Extracted rather than inlined at the webhook because that is the only place
 * the decision is observable: the webhook's own test fixtures cannot reach this
 * branch without standing up most of the merge path, and a condition that no
 * test can reach is a condition that can be silently inverted.
 *
 * Two halves, and both matter:
 *  - `merged` — a PR *closed* against a mission branch moved nothing. Announcing
 *    then would refresh a graph for a base that did not advance.
 *  - the shape heuristic, not `isMissionIntegrationBase` — this runs where the
 *    PR's base ref is known but the mission row is not, and the cost of being
 *    wrong is one no-op refresh. Trunk is excluded deliberately: it advances
 *    constantly, its seed is the default slot on the ordinary cooldown, and
 *    announcing every trunk merge would rebuild it every time.
 */
export function shouldAnnounceBaseAdvance(pr: {
  merged?: boolean | null;
  baseRef?: string | null;
}): boolean {
  return pr.merged === true && looksLikeMissionIntegrationBranch(pr.baseRef);
}

/**
 * Is `baseRef` a legal base for a mission task's pull request?
 *
 * The one predicate for "buildd did not open this PR (or its base moved after
 * the fact), so is it still where it belongs" — asked from PR adoption
 * (`create_pr` with an externally-supplied `prUrl`) and from webhook retarget
 * handling, which must never disagree about the answer.
 *
 * True whenever the mission has no integration base (nothing to enforce), or
 * `baseRef` equals it. The sole exception is the mission PR itself — its base
 * is trunk, by design — so callers must say which task they mean via
 * `isMissionPrTask`; this predicate has no way to tell a mission PR apart from
 * a task PR wrongly pointed at trunk without being told.
 */
export function isPrLegalForMissionTask(args: {
  baseRef?: string | null;
  mission?: MissionIntegrationFields | null;
  isMissionPrTask: boolean;
}): boolean {
  const integrationBase = missionIntegrationBase(args.mission);
  if (!integrationBase) return true;
  if (args.isMissionPrTask) return true;
  const ref = args.baseRef?.trim();
  return !!ref && ref === integrationBase;
}

/**
 * Does `contextBaseBranch` name a genuine stacked-plan predecessor, rather
 * than the Option A′ default or the recovery-task current-head marker?
 *
 * A stacked plan step's `context.baseBranch` names a *sibling task's own
 * branch* (`approve-plan.ts`'s `resolveDependencyBranch`) — real stacking,
 * and legitimately not the mission's integration branch, because the PR is
 * meant to merge into the predecessor's branch before that branch itself
 * lands on the integration branch. A recovery task's `context.baseBranch`
 * instead names the CURRENT head (a marker that predates `resumeBranch`) and
 * must not be mistaken for a stacked declaration — nor must the Option A′
 * default, where `context.baseBranch` was filled in as the integration base
 * itself and so trivially matches it.
 *
 * Every mission-integration derivation/enforcement point (PR creation,
 * adoption, retarget detection) must skip a task this returns `true` for —
 * its correct base is the recorded predecessor branch, not the mission's
 * integration branch, and forcing the latter would break the stack.
 */
export function isStackedPhaseBase(args: {
  contextBaseBranch?: string | null;
  head?: string | null;
  mission?: MissionIntegrationFields | null;
}): boolean {
  const integrationBase = missionIntegrationBase(args.mission);
  if (!integrationBase) return false;
  const base = args.contextBaseBranch?.trim();
  if (!base) return false;
  if (base === integrationBase) return false;
  if (base === args.head) return false;
  return true;
}

/** Which input decided a task PR's base. Reported so a caller can say why. */
export type TaskPrBaseSource =
  | 'mission_integration'
  | 'stacked_phase'
  | 'caller'
  | 'task_context'
  | 'workspace';

export interface TaskPrBaseResolution {
  /** The base this task's PR takes. Null only when no fallback was supplied. */
  base: string | null;
  source: TaskPrBaseSource;
  /** The mission's integration branch, whether or not it is being used. */
  integrationBase: string | null;
  /** Is the mission-integration base the answer for this task? */
  enforced: boolean;
}

export interface TaskPrBaseTask {
  title?: string | null;
  taskClass?: string | null;
  context?: unknown;
}

/**
 * **The** answer to "what base does this task's PR take" — one function, so the
 * prompt a worker reads and the guard that accepts its PR cannot disagree.
 *
 * They did disagree, and it cost a mission: the runner's Git Workflow block told
 * the agent to target `gitConfig.targetBranch` (trunk) because it never looked
 * at the mission, while `create_pr` derived the mission's integration branch and
 * refused trunk. The worker was instructed to do the one thing the server would
 * not accept, with no way to tell which side was wrong from inside the sandbox.
 *
 * Precedence, in order:
 *  1. the mission's integration branch, when it is being enforced for this task;
 *  2. an explicit `callerBase` (`create_pr`'s `base` argument);
 *  3. `context.baseBranch`, when it names something other than this task's own
 *     head — a stacked plan phase's predecessor branch, or a legacy CI-retry
 *     base. A value equal to the head is the recovery-task marker, not a base;
 *  4. the supplied `fallbacks`, most specific first.
 *
 * `integrationBaseMissing` is the escape hatch for the state this closes: the
 * integration branch was deleted (its mission PR merged early) and cannot be
 * restored, so enforcing it would send every later worker at a ref that 404s.
 * Saying so here — rather than at each call site — keeps the prompt and the
 * guard in agreement through the failure case too, and it also drops
 * `context.baseBranch` when that is the vanished branch.
 */
export function resolveTaskPrBase(args: {
  mission?: MissionIntegrationFields | null;
  task?: TaskPrBaseTask | null;
  /** The branch the PR is opened FROM (the worker's own branch). */
  head?: string | null;
  /** A base the caller asked for explicitly. Omitted when nobody asked. */
  callerBase?: string | null;
  /** Trunk-ward fallbacks, most specific first. */
  fallbacks?: Array<string | null | undefined>;
  /** True when the integration branch is known to be absent on the remote. */
  integrationBaseMissing?: boolean;
}): TaskPrBaseResolution {
  const integrationBase = missionIntegrationBase(args.mission);
  const rawContextBase = (args.task?.context as Record<string, unknown> | null | undefined)
    ?.baseBranch;
  const contextBaseBranch = typeof rawContextBase === 'string' ? rawContextBase : undefined;
  const isMissionPrOwner = args.task ? isMissionPrTask(args.task) : false;
  const isStackedPhase = isStackedPhaseBase({
    contextBaseBranch,
    head: args.head ?? null,
    mission: args.mission,
  });
  const enforced =
    !!integrationBase && !isMissionPrOwner && !isStackedPhase && !args.integrationBaseMissing;

  if (enforced) {
    return { base: integrationBase, source: 'mission_integration', integrationBase, enforced: true };
  }

  const caller = args.callerBase?.trim();
  if (caller) {
    return { base: caller, source: 'caller', integrationBase, enforced: false };
  }

  const ctxBase = contextBaseBranch?.trim();
  // A `context.baseBranch` equal to the head is the recovery-task current-head
  // marker, and one equal to a vanished integration branch is the very ref we
  // are routing around — neither is a base.
  const usableCtxBase =
    ctxBase && ctxBase !== args.head && !(args.integrationBaseMissing && ctxBase === integrationBase)
      ? ctxBase
      : undefined;
  if (usableCtxBase) {
    return {
      base: usableCtxBase,
      source: isStackedPhase ? 'stacked_phase' : 'task_context',
      integrationBase,
      enforced: false,
    };
  }

  for (const candidate of args.fallbacks ?? []) {
    const value = candidate?.trim();
    if (value) return { base: value, source: 'workspace', integrationBase, enforced: false };
  }
  return { base: null, source: 'workspace', integrationBase, enforced: false };
}
