/**
 * Lazy reconciliation: cross-check GitHub for workers whose PR still looks
 * un-merged, healing rows the pull_request webhook never delivered.
 *
 * Tier 2 of the reconciliation model (PR #1630): the read-through refresh in
 * pr-state-refresh.ts keeps rows fresh for workspaces someone is looking at;
 * this sweep is what covers the rest. Called by /api/cron/pr-reconcile, and
 * safe to call ad-hoc from scripts or admin routes.
 *
 * The gate is "when did we last check this row", not "how long has the row been
 * quiet". The previous `updatedAt < now() - 7 days` gate had three failures
 * measured against production: a webhook missed today was not a candidate for a
 * week; any write to the row (including a read-through check) reset the clock,
 * so busy rows were never candidates at all; and the overwhelming majority of
 * what it did select was already known-closed, burning one GitHub call each,
 * uncapped, inside a 60 s function.
 */

import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import { and, isNull, isNotNull, eq, lt, or, notInArray, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';

/**
 * On-demand merge-state check for a single worker.
 *
 * Calls GET /repos/{owner}/{repo}/pulls/{prNumber} and, if the PR is merged,
 * stamps mergedAt + prLifecycleStatus='merged' in the workers table.
 *
 * Returns true when a merge was detected and written, false otherwise.
 * Safe to call speculatively — skips the GitHub call if mergedAt is already set.
 */
export async function refreshWorkerMergeStateIfStale(
  worker: { id: string; prNumber: number; prUrl: string; mergedAt?: Date | null },
  installationId: number,
): Promise<boolean> {
  if (worker.mergedAt) return false;

  const match = worker.prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
  if (!match) return false;
  const repo = match[1];

  try {
    const pr = await githubApi(
      installationId,
      `/repos/${repo}/pulls/${worker.prNumber}`,
    ) as { state: string; merged: boolean; merged_at: string | null };

    if (pr.merged && pr.merged_at) {
      const now = new Date();
      await db.update(workers)
        .set({ mergedAt: new Date(pr.merged_at), prLifecycleStatus: 'merged', prLastCheckedAt: now, updatedAt: now })
        .where(eq(workers.id, worker.id));
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`[pr-reconcile] refreshWorkerMergeStateIfStale worker ${worker.id} PR #${worker.prNumber}:`, err);
    return false;
  }
}

/** A row is a candidate once its last check is older than this. */
export const RECONCILE_STALE_MS = 30 * 60 * 1000;

/**
 * Rows per run. Bounded so a run always finishes inside the route's
 * maxDuration (60 s) with RATE_LIMIT_MS between GitHub calls, and so a backlog
 * drains predictably across runs rather than timing out mid-sweep.
 */
export const RECONCILE_BATCH_CAP = 40;

/** Spacing between GitHub calls, matching pr-state-refresh.ts. */
const RATE_LIMIT_MS = 200;

/** Lifecycle states that need no further GitHub call. */
const TERMINAL_STATUSES = ['merged', 'closed'] as (
  'pr_open' | 'ci_running' | 'ci_green' | 'ci_failed' | 'merged' | 'conflict' | 'closed' | null
)[];

/**
 * Deferred so this module does not close an import cycle: task-dependencies
 * imports refreshWorkerMergeStateIfStale from here.
 */
async function notifyDependents(taskId: string): Promise<void> {
  const { checkDependsOnResolved } = await import('@/lib/task-dependencies');
  await checkDependsOnResolved(taskId);
}

export interface ReconcileResult {
  total: number;
  stamped: number;
  closed: number;
  skipped: number;
  /** Rows whose GitHub call failed; retried next run. */
  errors: number;
}

/**
 * Reconcile awaiting-merge workers against GitHub.
 *
 * For each candidate (PR set, not merged, not already terminal, unchecked for
 * RECONCILE_STALE_MS), fetches the PR and stamps mergedAt / prLifecycleStatus
 * accordingly. Open PRs are left open. Every row that is looked at — including
 * ones that were unchanged, unreachable or errored — has prLastCheckedAt
 * advanced, because the batch is ordered least-recently-checked first and a row
 * that never records a check would sit at the head of it forever.
 */
export async function reconcileStalePrWorkers(): Promise<ReconcileResult> {
  const cutoff = new Date(Date.now() - RECONCILE_STALE_MS);

  const candidates = await db.query.workers.findMany({
    where: and(
      isNotNull(workers.prNumber),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
      // notInArray is NULL-blind, so the null branch has to be explicit.
      or(
        isNull(workers.prLifecycleStatus),
        notInArray(workers.prLifecycleStatus, TERMINAL_STATUSES),
      ),
      or(
        isNull(workers.prLastCheckedAt),
        lt(workers.prLastCheckedAt, cutoff),
      ),
    ),
    columns: { id: true, prNumber: true, workspaceId: true, taskId: true },
    orderBy: sql`${workers.prLastCheckedAt} ASC NULLS FIRST`,
    limit: RECONCILE_BATCH_CAP,
  });

  const result: ReconcileResult = {
    total: candidates.length,
    stamped: 0,
    closed: 0,
    skipped: 0,
    errors: 0,
  };
  if (candidates.length === 0) return result;

  /** Advance the check clock so the row rotates to the back of the queue. */
  const recordCheck = async (id: string, extra: Record<string, unknown> = {}) => {
    const now = new Date();
    await db
      .update(workers)
      .set({ prLastCheckedAt: now, ...extra })
      .where(eq(workers.id, id));
  };

  // Group by workspace so we share one installation token per workspace
  const byWorkspace = new Map<string, typeof candidates>();
  for (const w of candidates) {
    if (!byWorkspace.has(w.workspaceId)) byWorkspace.set(w.workspaceId, []);
    byWorkspace.get(w.workspaceId)!.push(w);
  }

  let callIndex = 0;

  for (const [workspaceId, wsWorkers] of byWorkspace) {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { repo: true },
      with: { githubInstallation: { columns: { installationId: true } } },
    });

    if (!workspace?.repo || !workspace.githubInstallation?.installationId) {
      // Unreconcilable, not transient: without a repo + installation no GitHub
      // call is possible, so record the check rather than re-selecting these
      // rows every run and starving the rest of the batch.
      for (const worker of wsWorkers) {
        result.skipped++;
        await recordCheck(worker.id).catch(() => {});
      }
      continue;
    }

    const { repo } = workspace;
    const { installationId } = workspace.githubInstallation;

    for (const worker of wsWorkers) {
      if (!worker.prNumber) { result.skipped++; continue; }

      if (callIndex > 0) await new Promise<void>(r => setTimeout(r, RATE_LIMIT_MS));
      callIndex++;

      try {
        const pr = await githubApi(
          installationId,
          `/repos/${repo}/pulls/${worker.prNumber}`,
        ) as { state: string; merged: boolean; merged_at: string | null };

        if (pr.merged && pr.merged_at) {
          await recordCheck(worker.id, {
            mergedAt: new Date(pr.merged_at),
            prLifecycleStatus: 'merged',
            updatedAt: new Date(),
          });
          result.stamped++;
          // Stamping mergedAt is not enough — the dependency gate has to be
          // told, or the tasks this PR was blocking stay pending until some
          // other write pokes them.
          if (worker.taskId) {
            // Awaited, not fire-and-forget: this runs in a serverless function
            // that can be frozen the moment the handler resolves. Failure is
            // logged, never fatal to the sweep.
            await notifyDependents(worker.taskId).catch(err =>
              console.error(`[pr-reconcile] checkDependsOnResolved failed for task ${worker.taskId}:`, err),
            );
          }
        } else if (pr.state === 'closed') {
          await recordCheck(worker.id, {
            prLifecycleStatus: 'closed',
            updatedAt: new Date(),
          });
          result.closed++;
        } else {
          // Still open — record the check, change nothing else.
          await recordCheck(worker.id);
          result.skipped++;
        }
      } catch (err) {
        // Non-fatal: network error, 404 (PR deleted), rate-limit, etc. Record
        // the check so a permanently failing row costs one call per run
        // instead of blocking every run at the head of the queue.
        console.warn(`[pr-reconcile] worker ${worker.id} PR #${worker.prNumber}:`, err);
        result.errors++;
        await recordCheck(worker.id).catch(() => {});
      }
    }
  }

  return result;
}
