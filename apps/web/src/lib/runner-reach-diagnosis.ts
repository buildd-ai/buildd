/**
 * Why no runner can claim a pending task's workspace, in words a person can
 * act on. Pure, so the task page and its tests share one rule.
 *
 * Today this explains one cause, the one that strands a new user's first
 * task: the workspace is `restricted` (linked accounts only, see
 * ./workspace-reach) and the team's online runners are not linked to it.
 * Every other case returns null and the page keeps its usual "Waiting for a
 * runner" copy.
 */
import { accountReachesWorkspace, type ReachLink, type ReachWorkspace } from './workspace-reach';

export interface ReachRunner {
  accountId: string;
  accountTeamId: string;
  /** This account's link to the workspace, if any. */
  link: ReachLink | null;
}

export type RunnerReachDiagnosis =
  | {
      reason: 'restricted_unlinked';
      message: string;
      /** Online same-team runner accounts a link would let claim here. */
      fixAccountIds: string[];
    }
  | { reason: 'restricted_no_runner'; message: string; fixAccountIds: [] };

export const RESTRICTED_UNLINKED_MESSAGE =
  "No connected runner can claim tasks in this workspace: it's restricted and your runner isn't linked.";
export const RESTRICTED_NO_RUNNER_MESSAGE =
  'No runner can claim tasks in this workspace: it is restricted and no runner is linked to it.';

/** True when even the owning team's own accounts need a link (restricted). */
export function needsLinkForOwnTeam(workspace: ReachWorkspace): boolean {
  return !accountReachesWorkspace({ teamId: workspace.teamId }, workspace, null);
}

export function diagnoseRunnerReach(input: {
  workspace: ReachWorkspace;
  /** Runners with a live heartbeat. */
  onlineRunners: ReadonlyArray<ReachRunner>;
  /** Accounts linked to the workspace with canClaim, online or not. */
  linkedClaimerCount: number;
}): RunnerReachDiagnosis | null {
  const { workspace, onlineRunners, linkedClaimerCount } = input;
  if (!needsLinkForOwnTeam(workspace)) return null;
  if (onlineRunners.some((r) => accountReachesWorkspace({ teamId: r.accountTeamId }, workspace, r.link, 'canClaim'))) {
    return null;
  }
  // Only the owning team's accounts can be linked from here; another team's
  // runner needs that team's admins.
  const fixAccountIds = [...new Set(
    onlineRunners.filter((r) => r.accountTeamId === workspace.teamId).map((r) => r.accountId),
  )];
  if (fixAccountIds.length > 0) {
    return { reason: 'restricted_unlinked', message: RESTRICTED_UNLINKED_MESSAGE, fixAccountIds };
  }
  if (linkedClaimerCount === 0) {
    return { reason: 'restricted_no_runner', message: RESTRICTED_NO_RUNNER_MESSAGE, fixAccountIds: [] };
  }
  return null;
}
