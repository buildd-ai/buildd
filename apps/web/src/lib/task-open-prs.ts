/**
 * A task can ship as several PRs (a stacked series). Merging one of them is not
 * the task finishing: completing it on the first merge terminates the worker
 * that still owns the rest and releases dependents onto a half-landed task.
 *
 * The source of truth is `task_pull_requests`, written each time a PR is
 * registered to a task. It cannot be read off `workers`: a worker row holds ONE
 * PR and every report overwrites it, so a series from one worker leaves only its
 * latest PR there. Worker rows are still read as a fallback for PRs registered
 * before the registry existed (or by a path that does not record it).
 *
 * "Open" is a registered PR other than the one that just merged, that nothing
 * has recorded as merged or closed. Closing a PR unmerged is how one is
 * explicitly superseded or abandoned, so it stops blocking — and when it was
 * the last blocker of a task with merged work, `lastPrSettled` lets the close
 * event complete the task.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { taskPullRequests, workers } from '@buildd/core/db/schema';
import { isTerminalPrLifecycle } from '@/lib/dep-gate-contract';

interface PrRow {
  prUrl: string | null;
  prNumber: number | null;
  mergedAt: Date | string | null;
  prLifecycleStatus: string | null;
}

export function pickOtherOpenPrs(rows: readonly PrRow[], justMerged: { prUrl: string | null }): string[] {
  const mergedUrls = new Set(rows.filter(r => r.prUrl && r.mergedAt).map(r => r.prUrl!));
  if (justMerged.prUrl) mergedUrls.add(justMerged.prUrl);
  const open = new Set<string>();
  for (const r of rows) {
    if (!r.prUrl || r.prNumber == null) continue;
    if (mergedUrls.has(r.prUrl) || r.mergedAt) continue;
    if (isTerminalPrLifecycle(r.prLifecycleStatus)) continue;
    open.add(r.prUrl);
  }
  return [...open];
}

/** Record a PR as belonging to a task. Idempotent; never throws (best-effort bookkeeping). */
export async function recordTaskPr(input: {
  taskId: string | null | undefined;
  workerId?: string | null;
  prUrl: string | null | undefined;
  prNumber?: number | null;
}): Promise<void> {
  if (!input.taskId || !input.prUrl) return;
  try {
    await db.insert(taskPullRequests).values({
      taskId: input.taskId,
      workerId: input.workerId ?? null,
      prUrl: input.prUrl,
      prNumber: input.prNumber ?? null,
    }).onConflictDoNothing();
  } catch (e) {
    console.error(`[task-open-prs] could not record PR ${input.prUrl} for task ${input.taskId}:`, e);
  }
}

/** Reflect a PR's GitHub state in the registry (webhook closed / reopened). */
export async function markTaskPrState(prUrl: string, state: 'open' | 'merged' | 'closed'): Promise<void> {
  try {
    await db.update(taskPullRequests).set({ state }).where(eq(taskPullRequests.prUrl, prUrl));
  } catch (e) {
    console.error(`[task-open-prs] could not mark PR ${prUrl} ${state}:`, e);
  }
}

export async function otherOpenPrsOfTask(taskId: string, justMerged: { prUrl: string | null }): Promise<string[]> {
  const registered = await db
    .select({ prUrl: taskPullRequests.prUrl, state: taskPullRequests.state })
    .from(taskPullRequests)
    .where(eq(taskPullRequests.taskId, taskId));
  const open = new Set(
    registered
      .filter(r => r.state === 'open' && r.prUrl !== justMerged.prUrl)
      .map(r => r.prUrl),
  );
  // A PR the registry knows is settled must not be resurrected by a stale worker row.
  const settled = new Set(registered.filter(r => r.state !== 'open').map(r => r.prUrl));
  const rows = await db
    .select({
      prUrl: workers.prUrl,
      prNumber: workers.prNumber,
      mergedAt: workers.mergedAt,
      prLifecycleStatus: workers.prLifecycleStatus,
    })
    .from(workers)
    .where(eq(workers.taskId, taskId));
  for (const url of pickOtherOpenPrs(rows, justMerged)) {
    if (!settled.has(url)) open.add(url);
  }
  return [...open];
}

/**
 * Whether a task whose PR was just closed unmerged has nothing left in flight
 * and at least one merged PR — i.e. the close is what finishes it.
 */
export async function lastPrSettledWithMerge(taskId: string, closed: { prUrl: string | null }): Promise<boolean> {
  if ((await otherOpenPrsOfTask(taskId, closed)).length > 0) return false;
  const merged = await db
    .select({ id: taskPullRequests.id })
    .from(taskPullRequests)
    .where(and(eq(taskPullRequests.taskId, taskId), eq(taskPullRequests.state, 'merged')))
    .limit(1);
  if (merged.length > 0) return true;
  const mergedWorkers = await db
    .select({ id: workers.id, mergedAt: workers.mergedAt })
    .from(workers)
    .where(and(eq(workers.taskId, taskId), ne(workers.prUrl, closed.prUrl ?? '')));
  return mergedWorkers.some(w => w.mergedAt);
}
