/**
 * Option A′ on a surface — representing the mission integration PR.
 *
 * For an opted-in mission, every task PR merges into `mission/<slug>-<id8>` and
 * the mission's whole diff reaches trunk through exactly one PR from that
 * branch. Progress counters do not see it: `computeMissionProgress` counts
 * deliverable tasks only, so the row that owns the mission PR
 * (`taskClass: 'bookkeeping'`) contributes nothing, and `awaitingMerge` —
 * which counts *task* PRs — correctly reads 0 the moment they have all merged
 * into the integration branch. The header would then read "N of N tasks
 * complete" for a mission with nothing on trunk and one unmerged PR nobody
 * mentioned. That is the P4 gap this module closes.
 *
 * Pure, and deliberately importing only `@buildd/core/mission-integration`: the
 * mission surfaces are server components, but a derivation that reaches for
 * `lib/mission-pr.ts` would drag a DB client into the graph of anything that
 * later renders on the client.
 */

import {
  isMissionPrTask,
  missionIntegrationBase,
  type MissionIntegrationFields,
} from '@buildd/core/mission-integration';

export type MissionIntegrationPrState =
  /** Open on trunk: this is the mission's outstanding review gate. */
  | 'open'
  /** Merged into trunk — the mission's diff has landed. */
  | 'merged'
  /** Closed without merging: the diff is on the integration branch and nowhere else. */
  | 'closed'
  /**
   * Opted in, but no mission PR row exists yet. Not an error — the PR opens
   * when the last task PR merges — but it must be visible, because a mission
   * that reaches "all tasks done" in this state has nothing on trunk and no
   * gate to point a human at.
   */
  | 'not_opened';

export interface MissionIntegrationPrView {
  /** The mission's integration branch, i.e. the head of this PR. */
  branch: string;
  state: MissionIntegrationPrState;
  prNumber: number | null;
  prUrl: string | null;
  /** The bookkeeping task that owns the PR, for linking. */
  taskId: string | null;
}

/** The shape this module needs of a mission task the caller already loaded. */
export interface MissionPrTaskLike {
  id?: string | null;
  title?: string | null;
  taskClass?: string | null;
  workers?: Array<{
    prUrl?: string | null;
    prNumber?: number | null;
    mergedAt?: string | Date | null;
    prLifecycleStatus?: string | null;
  }> | null;
}

/**
 * The mission's integration PR as a surface should show it, or null when the
 * mission is not using an integration branch at all.
 *
 * Null is the "render exactly what you rendered before" answer: a mission that
 * never opted in has no mission PR and must gain no new chrome.
 */
export function deriveMissionIntegrationPr(args: {
  mission: MissionIntegrationFields | null | undefined;
  tasks: MissionPrTaskLike[] | null | undefined;
}): MissionIntegrationPrView | null {
  const branch = missionIntegrationBase(args.mission);
  if (!branch) return null;

  // Exactly one such PR exists per mission by construction
  // (`openMissionIntegrationPr` short-circuits on an existing owner), so the
  // first owning task carrying a PR is the answer.
  for (const task of args.tasks ?? []) {
    if (!isMissionPrTask(task)) continue;
    const worker = (task.workers ?? []).find((w) => w.prUrl);
    if (!worker) continue;
    return {
      branch,
      state: worker.mergedAt
        ? 'merged'
        : worker.prLifecycleStatus === 'closed'
          ? 'closed'
          : 'open',
      prNumber: worker.prNumber ?? null,
      prUrl: worker.prUrl ?? null,
      taskId: task.id ?? null,
    };
  }

  return { branch, state: 'not_opened', prNumber: null, prUrl: null, taskId: null };
}

/**
 * The line under the mission progress bar.
 *
 * The first three cases are the ones this line has always had. The fourth is
 * the point: when a mission's task PRs have all merged into the integration
 * branch, every task-level counter says "done", and the only thing left to say
 * is where the diff actually is.
 */
export function deriveMissionProgressSubline(args: {
  missionStatus: string;
  totalTasks: number;
  completedTasks: number;
  awaitingMerge: number;
  integrationPr: MissionIntegrationPrView | null;
}): string {
  const { missionStatus, totalTasks, completedTasks, awaitingMerge, integrationPr } = args;

  if (missionStatus === 'completed') return `${totalTasks} tasks · ${completedTasks} completed`;

  const tasksPart = awaitingMerge > 0
    ? `${completedTasks}/${totalTasks} done · ${awaitingMerge} awaiting merge`
    : `${completedTasks} of ${totalTasks} tasks complete`;

  const missionPart = missionIntegrationPrSuffix(integrationPr, { workLanded: completedTasks >= totalTasks && totalTasks > 0 });
  return missionPart ? `${tasksPart} · ${missionPart}` : tasksPart;
}

function missionIntegrationPrSuffix(
  pr: MissionIntegrationPrView | null,
  opts: { workLanded: boolean },
): string | null {
  if (!pr) return null;
  switch (pr.state) {
    case 'open':
      // The number is what a reader can act on, so it leads.
      return pr.prNumber != null ? `mission PR #${pr.prNumber} awaiting merge` : 'mission PR awaiting merge';
    case 'closed':
      return pr.prNumber != null ? `mission PR #${pr.prNumber} closed unmerged` : 'mission PR closed unmerged';
    case 'not_opened':
      // Only worth saying once the work is in: before that, "not open yet" is
      // the expected state and would be noise on every in-flight mission.
      return opts.workLanded ? 'mission PR not open yet' : null;
    case 'merged':
      // Nothing to add: the mission's diff is on trunk and the task counters
      // already say the work is done.
      return null;
  }
}

/**
 * Should the mission-PR block render at all?
 *
 * Same rule as the subline suffix, and for the same reason: an opted-in mission
 * that has not finished its work has nothing to say about a PR that is not due
 * yet, and a zero-signal block is chrome (surface-IA spec: absence is the empty
 * state). Once the work has landed, the block renders in every state — including
 * `not_opened`, which is exactly when a reader most needs to know.
 */
export function shouldRenderMissionPrBlock(
  pr: MissionIntegrationPrView | null,
  opts: { workLanded: boolean },
): boolean {
  if (!pr) return false;
  if (pr.state === 'not_opened') return opts.workLanded;
  return true;
}

/** Human label for the mission-PR card's state chip. */
export const MISSION_PR_STATE_LABEL: Record<MissionIntegrationPrState, string> = {
  open: 'AWAITING MERGE',
  merged: 'MERGED',
  closed: 'CLOSED UNMERGED',
  not_opened: 'NOT OPENED',
};
