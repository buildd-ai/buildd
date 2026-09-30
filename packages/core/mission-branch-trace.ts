/**
 * One signature for "a mission's integration branch could not be resolved".
 *
 * Before this existed the failure had no name of its own. The runner reported
 * it as `resume_branch_fallback` ("branch was missing on remote — starting
 * fresh"), which is the signature for a *prior attempt's* branch going away and
 * reads as routine retry noise; the server side posted a mission note and a
 * console line and nothing a rollup could count. So a mission whose integration
 * branch never existed looked, from get_error_traces and get_failure_analytics,
 * like a handful of unrelated singletons.
 *
 * Every path that fails to resolve the branch — the runner cutting a worktree,
 * `create_pr` deriving a PR base, mission create/update/organizer ensuring the
 * ref, the mission-PR opener — reports through this module, so:
 *
 *  - the error-trace `pattern` is always {@link MISSION_BRANCH_UNRESOLVED}, and
 *    the workspace rollup (GROUP BY pattern) puts every occurrence on one row;
 *  - the gate-ledger `reason` is built only from closed vocabularies (where,
 *    cause, fallback), never from the branch name or mission id, so
 *    `gateFrictionSignature` gives repeats the same signature. The variable
 *    parts go in `detail` and in the trace excerpt, where they are evidence
 *    rather than identity.
 *
 * Pure: no DB, no GitHub. The runner imports it too.
 */

/** Error-trace pattern AND gate slug. One name, so both surfaces group alike. */
export const MISSION_BRANCH_UNRESOLVED = 'mission_branch_unresolved';

/** Where resolution ran. */
export type MissionBranchResolutionSite =
  | 'runner_worktree'
  | 'create_pr'
  | 'mission_create'
  | 'mission_update'
  | 'mission_organizer'
  | 'task_create';

/**
 * Why the branch could not be used. `missing` is "not on the remote"; the rest
 * are `ensureMissionIntegrationBranch`'s failure reasons, i.e. why it could not
 * be (re)created either.
 */
export type MissionBranchUnresolvedCause =
  | 'missing'
  | 'no_repo'
  | 'empty_repo'
  | 'api_error'
  | 'no_working_branch';

/** What happened instead. */
export type MissionBranchFallback =
  /** Branch re-cut from trunk; work proceeds on it. Recovered. */
  | 'recut_from_trunk'
  /** Task PR opened against trunk instead of the integration branch. */
  | 'trunk_pr_base'
  /** Worktree cut from trunk instead of the integration branch. */
  | 'trunk_worktree'
  /** Nothing yet — surfaced for a person, see the mission note. */
  | 'none';

export interface MissionBranchUnresolvedInput {
  missionId?: string | null;
  /** The branch name that was expected to exist. */
  branch: string;
  where: MissionBranchResolutionSite;
  cause: MissionBranchUnresolvedCause;
  fallback: MissionBranchFallback;
  /** Free-text detail from the failing call (GitHub message, etc.). */
  detail?: string | null;
}

/**
 * Gate-ledger reason. Closed vocabularies only — see the module comment for
 * why the branch name must not appear here.
 */
export function missionBranchUnresolvedReason(
  input: Pick<MissionBranchUnresolvedInput, 'where' | 'cause' | 'fallback'>,
): string {
  return `mission integration branch unresolved at ${input.where}: ${input.cause}; fallback ${input.fallback}`;
}

/** Error-trace excerpt: the reason, plus the evidence a reader acts on. */
export function missionBranchUnresolvedExcerpt(input: MissionBranchUnresolvedInput): string {
  const mission = input.missionId ? ` mission ${input.missionId.slice(0, 8)}` : '';
  const detail = input.detail ? ` (${input.detail.slice(0, 200)})` : '';
  return `${missionBranchUnresolvedReason(input)} — expected "${input.branch}"${mission}${detail}`;
}

/** Structured `detail` for the gate-ledger row. */
export function missionBranchUnresolvedDetail(input: MissionBranchUnresolvedInput): Record<string, unknown> {
  return {
    branch: input.branch,
    where: input.where,
    cause: input.cause,
    fallback: input.fallback,
    ...(input.detail ? { detail: input.detail.slice(0, 500) } : {}),
  };
}

/**
 * The error trace a runner appends when a worktree could not be cut from the
 * ref it was asked for and fell back to trunk.
 *
 * Two different failures used to share `resume_branch_fallback`: a prior
 * attempt's branch going away (routine — retries start fresh), and the task's
 * *declared base* being the mission's integration branch and not existing
 * (not routine — every task of that mission lands on trunk until somebody
 * acts). The second is told apart by comparing the missing ref against the
 * mission's own integration branch; when the mission row is unavailable, the
 * `mission/` shape is the fallback heuristic. Its excerpt also stops promising
 * "a new PR will be opened instead of updating the existing one", which is only
 * true of the resume case.
 */
export function describeWorktreeFallback(args: {
  candidate: string;
  reason: 'missing' | 'diverged';
  defaultBranch: string;
  /** The task's mission integration branch, when the runner knows it. */
  integrationBase?: string | null;
  missionId?: string | null;
}): { pattern: string; excerpt: string; label: string } {
  const isIntegration =
    args.reason === 'missing'
    && (args.integrationBase
      ? args.candidate === args.integrationBase
      // Excludes the runner's worker-scoped diversion branches
      // (`mission/<slug>-w<workerId8>`), which are resume refs, not bases.
      : args.candidate.startsWith('mission/') && !/-w[0-9a-f]{8}$/.test(args.candidate));
  if (isIntegration) {
    const input: MissionBranchUnresolvedInput = {
      missionId: args.missionId ?? null,
      branch: args.candidate,
      where: 'runner_worktree',
      cause: 'missing',
      fallback: 'trunk_worktree',
    };
    return {
      pattern: MISSION_BRANCH_UNRESOLVED,
      excerpt: `${missionBranchUnresolvedExcerpt(input)} — worktree cut from "${args.defaultBranch}"; `
        + `create_pr will re-cut the branch from trunk or fall back to trunk, and say which on the mission feed.`,
      label: `Mission integration branch ${args.candidate} not on remote — worktree cut from ${args.defaultBranch}`,
    };
  }
  return {
    pattern: 'resume_branch_fallback',
    excerpt: `Branch "${args.candidate}" was ${args.reason} on remote — starting fresh from "${args.defaultBranch}". `
      + `A new PR will be opened instead of updating the existing one.`,
    label: `Resume branch ${args.reason}: ${args.candidate} — starting fresh from ${args.defaultBranch}`,
  };
}
