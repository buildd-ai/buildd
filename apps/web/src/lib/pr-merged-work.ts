/**
 * The work a merged worker PR owes, once per merge: the fact-cache stamp,
 * the task's completion, its dependents, the path-claim release, the
 * `pr.closed` / `task.pr_merge_delivered` / `task.pr_merged` fan-out (the
 * mission wake, dependent missions, the release trigger) and the work-tracker
 * update.
 *
 * Two callers, never both for one PR:
 *  - the `pull_request.closed` webhook, for a PR the workflow kernel does not
 *    own (opened before cutover, or released by the kill switch);
 *  - the kernel's `emit_pr_merged` effect (lib/workflow/pr-landing-effects.ts),
 *    for a kernel-owned PR, after `PrMerged` (T17) committed. The outbox makes
 *    it durable: a request killed between the merge and this work no longer
 *    loses it (docs/specs/workflow-state-kernel.md §10.1).
 *
 * Every step is idempotent or guarded on the row, so an at-least-once replay
 * of the effect repeats nothing a person can see. `mergeIsNew` gates the
 * once-per-merge steps: the webhook knows it from `workers.mergedAt`; the
 * effect runs once per merge by its dedupe key.
 */
import { after } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { emit } from '@/lib/core-emit';
import { reportTaskPolicyOutcome } from '@/lib/model-policy-outcomes';
import { checkDependsOnResolved, resolveCompletedTask } from '@/lib/task-dependencies';
import { detachInteractiveWorkersOfEndedTasks } from '@/lib/interactive-detach';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { postWorkTrackerCompletionUpdate } from '@/lib/work-tracker';
import { releaseAndNotify } from '@/lib/path-claim-release';
import { stampPrMergedOnAllRows } from '@/lib/pr-merge-stamp';
import { workerOwnsPr, workerOwnsPrUrl } from '@/lib/repo-scope';
import { otherOpenPrsOfTask } from '@/lib/task-open-prs';
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';

export interface MergedPrTask {
  id: string;
  status: string;
  workspaceId: string;
  missionId: string | null;
  taskClass: string | null;
  release: string | null;
  loopState: string | null;
}

export interface MergedPrWorkInput {
  worker: { id: string; workspaceId: string; taskId: string | null; runner?: string | null };
  task: MergedPrTask | null;
  repoFullName: string;
  prNumber: number;
  prUrl: string;
  prHtmlUrl: string;
  baseRef: string | null;
  headSha: string;
  installationId: number | null;
  /** GitHub's `merged_at` (§12): the instant the fact cache keeps. */
  mergedAt: Date | string;
  /** First report of this merge: gates the once-per-merge steps. */
  mergeIsNew: boolean;
  /** Stamp every row of the PR here. False when the kernel's `stamp_pr_rows` effect owns the stamp. */
  stamp: boolean;
}

/** Run inside `after()` when a request scope exists, inline otherwise (tests, the effect drain). */
async function afterOrNow(label: string, fn: () => Promise<void>): Promise<void> {
  const run = () => fn().catch((e) => console.error(`[pr-merged] ${label} failed:`, e));
  try {
    after(run);
  } catch {
    await run();
  }
}

/** Work-tracker: post the completion comment and move the linked issue, when the task has one. */
export async function maybePostWorkTrackerIssueUpdate(prNumber: number, prUrl: string, merged: boolean): Promise<void> {
  const worker = await db.query.workers.findFirst({
    where: workerOwnsPrUrl(prUrl, prNumber),
    with: { task: true },
  });
  const task = worker?.task;
  // A tracker link is either the id (Linear) or the issue URL (GitHub).
  if (!task || (!task.externalIssueId && !task.externalIssueUrl)) return;

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, task.workspaceId),
    columns: { workTrackerConfig: true, teamId: true },
  });
  if (!ws?.workTrackerConfig) return;

  // Provider-dispatched (Linear via connector, GitHub via the App installation).
  await postWorkTrackerCompletionUpdate({
    workspaceId: task.workspaceId,
    teamId: ws.teamId,
    config: ws.workTrackerConfig,
    externalIssueId: task.externalIssueId,
    externalIssueUrl: task.externalIssueUrl,
    prUrl,
    merged,
  });
}

/** The PR's worker row and its task, as both callers need them. */
export async function loadMergedPrOwner(repoFullName: string, prNumber: number) {
  return db.query.workers.findFirst({
    where: workerOwnsPr(repoFullName, prNumber),
    with: { task: true },
  });
}

export async function runMergedPrWork(p: MergedPrWorkInput): Promise<void> {
  const { worker, task } = p;
  if (p.stamp) {
    // Every row carrying this PR, not just one: a CI-retry attempt pushes to its
    // parent's branch and adopts the PR number, and a sibling left unstamped
    // reads as an open PR forever.
    await stampPrMergedOnAllRows({ prUrl: p.prUrl, prNumber: p.prNumber, mergedAt: p.mergedAt });
  }
  // Model policy: the merge, once (a redelivery is not a second merge).
  if (p.mergeIsNew) {
    await reportTaskPolicyOutcome(worker.taskId, [{ type: 'merged', merged: true }]);
  }
  await triggerEvent(channels.workspace(worker.workspaceId), events.WORKER_PROGRESS, { taskId: worker.taskId });

  // The task's file edits landed: held path claims unblock waiting tasks.
  if (worker.taskId) {
    const releaseTaskId = worker.taskId;
    await afterOrNow(`releaseAndNotify(${releaseTaskId})`, () => releaseAndNotify(releaseTaskId, 'merged'));
  }

  // Close open changeIntent rows, drop merge reservations and re-drive the PR
  // waiting behind it (missions); the reviews module measures the merge
  // against its verdict and cancels what the merge made obsolete.
  await emit({
    type: 'pr.closed',
    workspaceId: worker.workspaceId,
    prNumber: p.prNumber,
    merged: true,
    mergeIsNew: p.mergeIsNew,
    workerId: worker.id,
    taskId: worker.taskId ?? null,
    headSha: p.headSha,
    repoFullName: p.repoFullName,
    installationId: p.installationId,
  });

  if (!task) return;

  // Unblock dependents now that the merge is stamped: this fires even when the
  // task was already completed, because checkDependsOnResolved gates on mergedAt.
  checkDependsOnResolved(task.id).catch((e) =>
    console.error(`[pr-merged] checkDependsOnResolved failed for task ${task.id}:`, e),
  );

  // Every merged PR: the missions module advances a loop waiting on this merge
  // and, for a task PR landing on a mission integration branch, opens the one
  // mission PR.
  await emit({
    type: 'task.pr_merge_delivered',
    taskId: task.id,
    workerId: worker.id,
    workspaceId: worker.workspaceId,
    missionId: task.missionId ?? null,
    baseRef: p.baseRef,
  });

  // `tasks.status = 'completed'` belongs to the TRANSITION (this merge
  // finished the task); everything after it belongs to the MERGE, and is true
  // whatever the task row already said.
  let transition: 'flipped' | 'already_completed' | 'not_flipped' = 'already_completed';
  // A stacked series: the task owns more PRs than this one. Its first merge
  // must not complete the task; the last one does.
  const openSiblingPrs = task.status !== 'completed' ? await otherOpenPrsOfTask(task.id, { prUrl: p.prUrl }) : [];
  if (task.status !== 'completed' && p.worker.runner === INTERACTIVE_WORKER_RUNNER) {
    // A local session decides when it is done (it may still be planning PR B..D,
    // which no open-PR check can see); only its complete_task ends the task.
    transition = 'not_flipped';
    console.log(`Task ${task.id} stays open after PR #${p.prNumber} merged: interactive session completes its own task`);
  } else if (openSiblingPrs.length > 0) {
    transition = 'not_flipped';
    console.log(`Task ${task.id} stays open after PR #${p.prNumber} merged: ${openSiblingPrs.length} other PR(s) still open`);
  } else if (task.status !== 'completed') {
    // Guarded on the row: the worker's own completion can land between the
    // read and this write, and only the writer that flips it resolves it.
    const [flipped] = await db
      .update(tasks)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), ne(tasks.status, 'completed')))
      .returning({ id: tasks.id });
    transition = flipped ? 'flipped' : 'not_flipped';
    if (flipped) {
      console.log(`Auto-completed task ${task.id} via merged PR #${p.prNumber} on ${p.repoFullName}`);
      // Same fact as the worker route's completion, same dedupe key: one row.
      await emit({ type: 'task.completed', via: 'merge', taskId: task.id, workerId: worker.id, workspaceId: worker.workspaceId });
      // One-shot announcement on the linked issue, inside the transition guard.
      maybePostWorkTrackerIssueUpdate(p.prNumber, p.prHtmlUrl, true).catch(() => {});
      // Parent rollup, dependents, mission completion and re-planning. A loop
      // task waiting on this merge is resolved by its own loop advancement.
      if (task.loopState !== 'condition_unmet') {
        await resolveCompletedTask(task.id, task.workspaceId).catch((e) =>
          console.error(`[pr-merged] resolveCompletedTask failed for task ${task.id}:`, e),
        );
      }
    }
  }

  // A local session that opened this PR stops holding a seat now the task is done.
  await detachInteractiveWorkersOfEndedTasks({ taskId: task.id, graceMs: 0 });

  if (p.mergeIsNew) {
    // Effects of the merge itself, once per merge: the missions module wakes the
    // mission and unblocks missions gated on this one's merges; the releases
    // module runs the post-merge release trigger (Path B).
    await emit({
      type: 'task.pr_merged',
      via: 'worker',
      transition,
      taskClass: task.taskClass ?? null,
      taskId: task.id,
      workerId: worker.id,
      workspaceId: task.workspaceId,
      missionId: task.missionId ?? null,
      release: task.release ?? null,
      repoFullName: p.repoFullName,
      baseRef: p.baseRef,
      installationId: p.installationId,
    });
  }
}
