/**
 * Lazy reconciliation: cross-check GitHub for workers stuck in the
 * "awaiting merge" state (prUrl set, mergedAt null) for longer than STALE_DAYS.
 *
 * Called by the /api/cron/pr-reconcile cron job (daily).
 * Also safe to call ad-hoc from scripts or admin routes.
 */

import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import { and, isNull, isNotNull, eq, lt } from 'drizzle-orm';
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

/** Workers older than this are candidates for reconciliation. */
const STALE_DAYS = 7;

export interface ReconcileResult {
  total: number;
  stamped: number;
  closed: number;
  skipped: number;
}

/**
 * Reconcile stale awaiting-merge workers against GitHub.
 *
 * For each worker where prNumber IS NOT NULL AND mergedAt IS NULL AND
 * updatedAt < now() - STALE_DAYS, fetches the PR from GitHub and stamps
 * mergedAt / prLifecycleStatus accordingly. Open PRs are left untouched.
 */
export async function reconcileStalePrWorkers(): Promise<ReconcileResult> {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db.query.workers.findMany({
    where: and(
      isNotNull(workers.prNumber),
      isNull(workers.mergedAt),
      isNotNull(workers.prUrl),
      lt(workers.updatedAt, cutoff),
    ),
    columns: { id: true, prNumber: true, workspaceId: true },
  });

  const result: ReconcileResult = { total: candidates.length, stamped: 0, closed: 0, skipped: 0 };
  if (candidates.length === 0) return result;

  // Group by workspace so we share one installation token per workspace
  const byWorkspace = new Map<string, typeof candidates>();
  for (const w of candidates) {
    if (!byWorkspace.has(w.workspaceId)) byWorkspace.set(w.workspaceId, []);
    byWorkspace.get(w.workspaceId)!.push(w);
  }

  for (const [workspaceId, wsWorkers] of byWorkspace) {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { repo: true },
      with: { githubInstallation: { columns: { installationId: true } } },
    });

    if (!workspace?.repo || !workspace.githubInstallation?.installationId) {
      result.skipped += wsWorkers.length;
      continue;
    }

    const { repo } = workspace;
    const { installationId } = workspace.githubInstallation;

    for (const worker of wsWorkers) {
      if (!worker.prNumber) { result.skipped++; continue; }

      try {
        const pr = await githubApi(
          installationId,
          `/repos/${repo}/pulls/${worker.prNumber}`,
        ) as { state: string; merged: boolean; merged_at: string | null };

        if (pr.merged && pr.merged_at) {
          await db.update(workers)
            .set({ mergedAt: new Date(pr.merged_at), prLifecycleStatus: 'merged', updatedAt: new Date() })
            .where(eq(workers.id, worker.id));
          result.stamped++;
        } else if (pr.state === 'closed') {
          await db.update(workers)
            .set({ prLifecycleStatus: 'closed', updatedAt: new Date() })
            .where(eq(workers.id, worker.id));
          result.closed++;
        } else {
          // Still open — don't touch it
          result.skipped++;
        }
      } catch {
        // Non-fatal: network error, 404 (PR deleted), rate-limit, etc.
        // The next cron run will retry.
        result.skipped++;
      }
    }
  }

  return result;
}
