/**
 * Is a mission's deliverable work finished? The pure half of
 * `evaluateMissionWorkState` (lib/mission-pr.ts), so the stored mission
 * summary can answer it from the rows it already read, and the merge gate's
 * refusal text (`missionWorkHolder`) is one function for both.
 */
import { OPEN_TASK_STATUSES } from '@buildd/shared';
import { isMissionIntegrationBase } from '@buildd/core/mission-integration';
import { TERMINAL_PR_LIFECYCLE } from '@/lib/dep-gate-contract';

/** Statuses in which a task still represents unlanded deliverable work. */
const UNFINISHED_TASK_STATUSES = OPEN_TASK_STATUSES;

export interface MissionWorkTaskRow {
  id: string;
  title: string;
  status: string;
  mode?: string | null;
  taskClass?: string | null;
}

/** The organizer's planning task and the bookkeeping row that owns the mission PR are not deliverable. */
export function isDeliverableMissionTask(t: { mode?: string | null; taskClass?: string | null }): boolean {
  return t.mode !== 'planning' && t.taskClass === 'work';
}

/**
 * Worker states in which a PR row still represents work waiting to land.
 *
 * A PR that was closed unmerged, or given up on, will never merge — so it must
 * not count as outstanding. Every other gate in this codebase carries this
 * exclusion (`claim/route.ts`, `claim/deps-gate.ts`, `mission-run.ts`); this one
 * did not, and a single superseded retry PR or one human-closed PR pinned the
 * mission at `prs_unmerged` permanently.
 */
export const DEAD_PR_LIFECYCLE: ReadonlySet<string> = new Set(TERMINAL_PR_LIFECYCLE);

export interface MissionWorkerRow {
  taskId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prBaseRef: string | null;
  mergedAt: Date | null;
  prLifecycleStatus: string | null;
  startedAt: Date | null;
  createdAt: Date;
}

/**
 * The newest worker per task.
 *
 * Ordered in JS rather than by SQL `orderBy` on purpose: `workers.startedAt` is
 * nullable with no default, and Postgres `DESC` sorts NULLs *first*, so a
 * never-started worker would outrank the real one. Falls back to `createdAt`.
 */
export function latestWorkerByTask(rows: readonly MissionWorkerRow[]): Map<string, MissionWorkerRow> {
  const rank = (w: MissionWorkerRow) => (w.startedAt ?? w.createdAt)?.valueOf() ?? 0;
  const out = new Map<string, MissionWorkerRow>();
  for (const w of rows) {
    if (!w.taskId) continue;
    const seen = out.get(w.taskId);
    if (!seen || rank(w) >= rank(seen)) out.set(w.taskId, w);
  }
  return out;
}

/** Does this worker hold a PR that is still expected to merge? */
function holdsLivePr(w: MissionWorkerRow | undefined): boolean {
  if (!w?.prUrl) return false;
  if (w.mergedAt) return false;
  return !DEAD_PR_LIFECYCLE.has(w.prLifecycleStatus ?? '');
}

/** A deliverable task that can still produce a PR, named so a refusal can say so. */
export interface UnfinishedMissionTask {
  id: string;
  title: string;
  status: string;
}

/** A deliverable task whose PR is open and still expected to merge. */
export interface UnmergedMissionPr {
  id: string;
  title: string;
  prNumber: number | null;
}

export interface MissionWorkState {
  /** Every deliverable task has landed, and none is still waiting on a PR. */
  complete: boolean;
  /**
   * Why not, when `complete` is false. `no_deliverable_work` is the honest
   * "there is nothing to ship" verdict and is deliberately NOT complete: an
   * empty set must not open an empty PR.
   */
  reason: 'complete' | 'no_deliverable_work' | 'tasks_unfinished' | 'prs_unmerged';
  unfinishedTaskCount: number;
  unmergedPrCount: number;
  /**
   * Both lists are populated on EVERY answer, not only the one `reason` names.
   *
   * `reason` is a precedence verdict — "tasks unfinished" outranks "PRs open"
   * because the task is the actionable blocker — and it used to zero the other
   * side's count on the way out. A caller reading one field then saw "no PRs
   * open" on a mission that had barely started, which is precisely how the
   * merge gate came to allow merging a mission PR over unstarted work.
   */
  unfinishedTasks: UnfinishedMissionTask[];
  unmergedPrs: UnmergedMissionPr[];
  /**
   * Deliverable tasks whose PR merged into this mission's integration branch.
   * Zero means the mission has nothing for a mission PR to carry — the honest
   * "nothing to ship" signal, and the reason a mission whose work was all
   * cancelled must not be held open waiting for a PR that would be empty.
   */
  landedOnIntegrationCount: number;
  /**
   * Every deliverable task PR that merged, with the base it merged into and
   * when (a delivery's branch, or trunk for a task that predates the branch). The
   * completion gate reads it per delivery (`epochCompletionHold`): after a
   * rotation the current branch is not the one earlier work landed on.
   */
  landedOnIntegration: Array<{ taskId: string; baseRef: string; mergedAt: string | null }>;
}

/**
 * Is this mission's deliverable work all landed on the integration branch?
 *
 * Counts only deliverable tasks — the organizer's planning task and the
 * bookkeeping row that owns the mission PR are excluded, because including
 * either makes the predicate self-referential.
 *
 * **Landedness is read from `workers`, not from `tasks.status`.** A task whose
 * PR has merged has landed, whatever its row currently says. That matters
 * because the webhook stamps `workers.mergedAt` *before* `tasks.status`, so two
 * of a mission's last task PRs merging concurrently would each see the other's
 * task still `in_progress` and both decline to open the mission PR — and since
 * the webhook is the trigger, both declining means it never opens.
 *
 * Note what this deliberately does NOT do: it never returns `complete` for a
 * mission with zero deliverable tasks. A "green over an empty set" answer here
 * would open a PR with no commits on it, which is the failure mode this
 * codebase keeps rediscovering.
 */
export function missionWorkStateFromRows(
  mission: { workingBranch?: string | null; integrationBranchEnabled?: boolean | null } | null | undefined,
  missionTasks: ReadonlyArray<MissionWorkTaskRow>,
  allWorkers: ReadonlyArray<MissionWorkerRow>,
  opts?: { assumeCompletedTaskIds?: string[] },
): MissionWorkState {
  const assumeCompleted = new Set(opts?.assumeCompletedTaskIds ?? []);
  const deliverable = missionTasks.filter(isDeliverableMissionTask);
  const empty = {
    complete: false as const,
    unfinishedTaskCount: 0,
    unmergedPrCount: 0,
    unfinishedTasks: [] as UnfinishedMissionTask[],
    unmergedPrs: [] as UnmergedMissionPr[],
    landedOnIntegrationCount: 0,
    landedOnIntegration: [] as MissionWorkState['landedOnIntegration'],
  };
  if (deliverable.length === 0) {
    return { ...empty, reason: 'no_deliverable_work' };
  }

  const latest = latestWorkerByTask(allWorkers);

  const landedOnIntegrationCount = deliverable.filter(t => {
    const w = latest.get(t.id);
    return !!w?.mergedAt && isMissionIntegrationBase({ baseRef: w.prBaseRef, mission });
  }).length;
  // Every merged deliverable PR with its base; a reader keeps the bases that are deliveries' branches.
  const landedOnIntegration = deliverable.flatMap(t => {
    const w = latest.get(t.id);
    if (!w?.mergedAt || !w.prBaseRef) return [];
    return [{ taskId: t.id, baseRef: w.prBaseRef, mergedAt: new Date(w.mergedAt).toISOString() }];
  });

  // Waiting on a PR: the task's live worker holds one that is still expected to
  // merge. Checked before the status sweep so a `completed` task with an open PR
  // reports the PR, which is the actionable blocker.
  const awaitingPr = deliverable.filter(t => holdsLivePr(latest.get(t.id)));

  // Unfinished: a non-terminal task that has not already landed a PR. A merged
  // PR outranks the row's status — see the note above.
  const unfinished = deliverable.filter(t => {
    if (assumeCompleted.has(t.id)) return false;
    if (latest.get(t.id)?.mergedAt) return false;
    return (UNFINISHED_TASK_STATUSES as readonly string[]).includes(t.status);
  });

  const unfinishedTasks: UnfinishedMissionTask[] = unfinished.map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
  }));
  const unmergedPrs: UnmergedMissionPr[] = awaitingPr.map(t => ({
    id: t.id,
    title: t.title,
    prNumber: latest.get(t.id)?.prNumber ?? null,
  }));
  // Both sides are reported on every answer — see MissionWorkState.
  const counts = {
    unfinishedTaskCount: unfinished.length,
    unmergedPrCount: awaitingPr.length,
    unfinishedTasks,
    unmergedPrs,
    landedOnIntegrationCount,
    landedOnIntegration,
  };

  if (unfinished.length > 0) {
    return { ...counts, complete: false, reason: 'tasks_unfinished' };
  }
  if (awaitingPr.length > 0) {
    return { ...counts, complete: false, reason: 'prs_unmerged' };
  }

  return { ...counts, complete: true, reason: 'complete' };
}

/** How many held items a refusal names before it summarises the rest. */
const REFUSAL_NAME_LIMIT = 5;

function nameHolders(labels: string[]): string {
  if (labels.length <= REFUSAL_NAME_LIMIT) return labels.join(', ');
  const shown = labels.slice(0, REFUSAL_NAME_LIMIT);
  return `${shown.join(', ')} and ${labels.length - REFUSAL_NAME_LIMIT} more`;
}

/**
 * Why the mission PR may not merge yet because of its work, or null: the
 * open task PRs and the tasks that have not opened one, named.
 */
export function missionWorkHolder(work: MissionWorkState): string | null {
  const holders: string[] = [];
  if (work.unmergedPrs.length > 0) {
    const named = nameHolders(
      work.unmergedPrs.map(p => (p.prNumber ? `PR #${p.prNumber} (${p.title})` : `an open PR on ${p.title}`)),
    );
    holders.push(
      `${work.unmergedPrCount} task PR(s) still open on the integration branch: ${named}`,
    );
  }
  if (work.unfinishedTasks.length > 0) {
    const named = nameHolders(work.unfinishedTasks.map(t => `${t.title} [${t.status}]`));
    holders.push(
      `${work.unfinishedTaskCount} mission task(s) that have not opened a PR yet: ${named}`,
    );
  }
  return holders.length === 0
    ? null
    : `This mission's work is not finished — ${holders.join('; and ')}. Merging the mission PR `
      + `now would delete the integration branch out from under work that still needs it. `
      + `Cancel the remaining task(s), or let them land, then merge.`;
}
