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
import { openDeliveryFinished, type FinishedReason } from '@buildd/workflow-kernel/delivery-epochs';

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
  /**
   * With delivery records (workflow-kernel-library.md §6): which delivery this
   * view is (the writable one, else the newest), and the ones that already
   * reached trunk. Absent for a mission that predates them.
   */
  delivery?: number;
  shippedDeliveries?: Array<{ delivery: number; prNumber: number | null; prUrl: string | null }>;
  /**
   * A closed PR whose branch is finished (`deliveryBranchFinished`, task
   * fbc93ebd): its work is recorded as landed in `satisfiedByPr`, so nothing
   * more ships from the branch. Absent while the branch is still live.
   */
  finished?: { reason: FinishedReason; satisfiedByPr: number | null };
}

/** The delivery record as a surface reads it (`EpochSnapshot`'s shown fields). */
export interface MissionDeliveryLike {
  epoch: number;
  branch: string;
  state: 'open' | 'merged';
  prNumber: number | null;
  repoFullName: string | null;
  ownerTaskId?: string | null;
}

const prUrlOf = (d: MissionDeliveryLike): string | null =>
  d.prNumber != null && d.repoFullName ? `https://github.com/${d.repoFullName}/pull/${d.prNumber}` : null;

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
    /** The merged PR recorded as carrying this PR's work, when it closed unmerged. */
    supersededByPrNumber?: number | null;
  }> | null;
}

/**
 * The finished reading of a closed mission PR. Only what the rows record: a
 * supersession edge on the owner's worker. A branch proven contained in trunk
 * by a content check is finished for settlement, but no row records that here.
 */
function finishedOf(supersededBy: number | null | undefined): MissionIntegrationPrView['finished'] {
  const f = openDeliveryFinished({ prClosedUnmerged: true, supersededBy: supersededBy ?? null, containedInTrunk: null, successorOpen: false });
  return f.finished ? { reason: f.reason, satisfiedByPr: f.satisfiedByPr } : undefined;
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
  /** The mission's delivery records, ordered. When present they decide; the owner rows are not read. */
  deliveries?: MissionDeliveryLike[] | null;
}): MissionIntegrationPrView | null {
  const branch = missionIntegrationBase(args.mission);
  if (!branch) return null;

  // A merged mission PR is one delivery, not the mission: the view is the
  // writable delivery, with the shipped ones named beside it.
  const deliveries = [...(args.deliveries ?? [])].sort((a, b) => a.epoch - b.epoch);
  if (deliveries.length > 0) {
    const open = deliveries.find((d) => d.state === 'open') ?? null;
    const current = open ?? deliveries[deliveries.length - 1]!;
    const shippedDeliveries = deliveries
      .filter((d) => d.state === 'merged' && d !== current)
      .map((d) => ({ delivery: d.epoch, prNumber: d.prNumber, prUrl: prUrlOf(d) }));
    const ownerWorker = (args.tasks ?? []).filter(isMissionPrTask)
      .flatMap((t) => (t.workers ?? []).map((w) => ({ t, w })))
      .find(({ w }) => current.prNumber != null && w.prNumber === current.prNumber);
    const state: MissionIntegrationPrState = current.state === 'merged'
      ? 'merged'
      : current.prNumber == null
        ? 'not_opened'
        : ownerWorker?.w.prLifecycleStatus === 'closed' ? 'closed' : 'open';
    const finished = state === 'closed' ? finishedOf(ownerWorker?.w.supersededByPrNumber) : undefined;
    return {
      branch: current.branch, state, prNumber: current.prNumber, prUrl: prUrlOf(current) ?? ownerWorker?.w.prUrl ?? null,
      taskId: current.ownerTaskId ?? ownerWorker?.t.id ?? null, delivery: current.epoch, shippedDeliveries,
      ...(finished ? { finished } : {}),
    };
  }

  // Exactly one such PR exists per mission by construction
  // (`openMissionIntegrationPr` short-circuits on an existing owner), so the
  // first owning task carrying a PR is the answer.
  for (const task of args.tasks ?? []) {
    if (!isMissionPrTask(task)) continue;
    const worker = (task.workers ?? []).find((w) => w.prUrl);
    if (!worker) continue;
    const state: MissionIntegrationPrState = worker.mergedAt
      ? 'merged'
      : worker.prLifecycleStatus === 'closed'
        ? 'closed'
        : 'open';
    const finished = state === 'closed' ? finishedOf(worker.supersededByPrNumber) : undefined;
    return {
      branch,
      state,
      prNumber: worker.prNumber ?? null,
      prUrl: worker.prUrl ?? null,
      taskId: task.id ?? null,
      ...(finished ? { finished } : {}),
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
      if (pr.delivery && pr.delivery > 1) return pr.prNumber != null ? `delivery ${pr.delivery} PR #${pr.prNumber} awaiting merge` : `delivery ${pr.delivery} awaiting merge`;
      return pr.prNumber != null ? `mission PR #${pr.prNumber} awaiting merge` : 'mission PR awaiting merge';
    case 'closed':
      if (pr.finished?.satisfiedByPr != null) {
        return `${pr.prNumber != null ? `mission PR #${pr.prNumber}` : 'mission PR'} closed, work landed in #${pr.finished.satisfiedByPr}`;
      }
      return pr.prNumber != null ? `mission PR #${pr.prNumber} closed unmerged` : 'mission PR closed unmerged';
    case 'not_opened':
      // Only worth saying once the work is in: before that, "not open yet" is
      // the expected state and would be noise on every in-flight mission.
      if (pr.delivery && pr.delivery > 1) return opts.workLanded ? `delivery ${pr.delivery} PR not open yet` : `delivery ${pr.delivery - 1} shipped`;
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

/**
 * What the mission-PR line says, in words (no chips): the current delivery
 * leads, a shipped delivery is a fact beside it, never the mission's verdict.
 * Null heading = the pre-delivery wording ("Mission PR").
 */
export function describeMissionDelivery(pr: MissionIntegrationPrView): { heading: string; line: string; earlier: string | null } {
  const earlier = (pr.shippedDeliveries ?? []).length > 0
    ? (pr.shippedDeliveries ?? []).map((d) => `Delivery ${d.delivery} merged${d.prNumber != null ? ` (#${d.prNumber})` : ''}`).join(', ') + '.'
    : null;
  const landedIn = pr.state === 'closed' && pr.finished?.satisfiedByPr != null ? pr.finished.satisfiedByPr : null;
  if (!pr.delivery) {
    return {
      heading: 'Mission PR',
      line: pr.state === 'not_opened'
        ? 'Task PRs merge into the integration branch. No PR to the target branch is open, so none of this work has shipped.'
        : pr.state === 'merged'
          ? "This mission's work reached the target branch through one PR from its integration branch."
          : landedIn != null
            ? `The mission PR closed without merging and its work landed in #${landedIn}. This branch is finished: nothing more ships from it.`
            : "All of this mission's work ships in this one PR.",
      earlier,
    };
  }
  const n = pr.delivery;
  const line = pr.state === 'merged'
    ? `Delivery ${n} reached the target branch. Work added to the mission from here goes out in a new delivery.`
    : pr.state === 'not_opened'
      ? `The work still to come goes into delivery ${n} on this branch. Nothing on it has shipped yet.`
      : pr.state === 'closed'
        ? landedIn != null
          ? `Delivery ${n}'s PR closed without merging and its work landed in #${landedIn}. This branch is finished: nothing more ships from it.`
          : `Delivery ${n}'s PR was closed without merging, so its work is only on this branch.`
        : `Delivery ${n}'s work ships in this PR.`;
  return { heading: `Delivery ${n}`, line, earlier };
}
