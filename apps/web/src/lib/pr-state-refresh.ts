/**
 * Read-through PR state refresh.
 *
 * Called from mission detail and task list API routes. Fires in the background
 * (never blocks the response) and pushes corrected state over WORKER_PROGRESS
 * so open views update without a reload.
 *
 * Rate-limited to match the backfill script (200 ms between GitHub calls).
 * Batch capped at 10 workers per render to bound GitHub API fan-out.
 * Non-fatal: GitHub errors are logged; prLastCheckedAt is left unset so the
 * next render retries.
 */

import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { checkDependsOnResolved } from '@/lib/task-dependencies';

const BATCH_CAP = 10;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MS = 200;

const TERMINAL_STATUSES = ['merged', 'closed'] as ('pr_open' | 'ci_running' | 'ci_green' | 'ci_failed' | 'merged' | 'conflict' | 'closed' | null)[];

export interface StalePrCandidate {
  id: string;
  prNumber: number | null;
  workspaceId: string;
  taskId: string | null;
  prLifecycleStatus: string | null;
  prLastCheckedAt: Date | null;
}

/**
 * Refresh stale PR state by querying workers in the given workspaces from the
 * DB. Used by the task list route where workers are not already in memory.
 */
export async function refreshStaleWorkersForWorkspaces(workspaceIds: string[]): Promise<void> {
  if (workspaceIds.length === 0) return;

  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const candidates = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, workspaceIds),
      isNotNull(workers.prNumber),
      or(
        isNull(workers.prLifecycleStatus),
        notInArray(workers.prLifecycleStatus, TERMINAL_STATUSES),
      ),
      or(
        isNull(workers.prLastCheckedAt),
        lt(workers.prLastCheckedAt, staleCutoff),
      ),
    ),
    columns: { id: true, prNumber: true, workspaceId: true, taskId: true },
    limit: BATCH_CAP,
  });

  await _processWorkerBatch(
    candidates.map(c => ({ id: c.id, prNumber: c.prNumber!, workspaceId: c.workspaceId, taskId: c.taskId })),
  );
}

/**
 * Refresh stale PR state from a pre-fetched list of workers (e.g. those
 * already returned by the mission detail query). Avoids a second DB round-trip.
 */
export async function refreshStaleWorkers(candidates: StalePrCandidate[]): Promise<void> {
  const now = Date.now();
  const stale = candidates
    .filter(w => {
      if (!w.prNumber) return false;
      if (TERMINAL_STATUSES.includes(w.prLifecycleStatus as any)) return false;
      const lastChecked = w.prLastCheckedAt?.getTime() ?? 0;
      return now - lastChecked >= STALE_THRESHOLD_MS;
    })
    .slice(0, BATCH_CAP);

  await _processWorkerBatch(
    stale.map(w => ({ id: w.id, prNumber: w.prNumber!, workspaceId: w.workspaceId, taskId: w.taskId })),
  );
}

// ─── Internal ─────────────────────────────────────────────────────────────────

interface _Candidate {
  id: string;
  prNumber: number;
  workspaceId: string;
  taskId: string | null;
}

async function _processWorkerBatch(candidates: _Candidate[]): Promise<void> {
  if (candidates.length === 0) return;

  // Group by workspace to share one installation token per workspace.
  const byWorkspace = new Map<string, _Candidate[]>();
  for (const w of candidates) {
    if (!byWorkspace.has(w.workspaceId)) byWorkspace.set(w.workspaceId, []);
    byWorkspace.get(w.workspaceId)!.push(w);
  }

  for (const [workspaceId, wsWorkers] of byWorkspace) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { repo: true },
      with: { githubInstallation: { columns: { installationId: true } } },
    });

    if (!ws?.repo || !ws.githubInstallation?.installationId) continue;

    const { repo } = ws;
    const { installationId } = ws.githubInstallation;

    for (let i = 0; i < wsWorkers.length; i++) {
      const worker = wsWorkers[i];

      if (i > 0) {
        await new Promise<void>(r => setTimeout(r, RATE_LIMIT_MS));
      }

      try {
        const pr = await githubApi(
          installationId,
          `/repos/${repo}/pulls/${worker.prNumber}`,
        ) as { state: string; merged: boolean; merged_at: string | null };

        const now = new Date();
        const update: Record<string, unknown> = { prLastCheckedAt: now, updatedAt: now };
        let didMerge = false;

        if (pr.merged && pr.merged_at) {
          update.mergedAt = new Date(pr.merged_at);
          update.prLifecycleStatus = 'merged';
          didMerge = true;
        } else if (pr.state === 'closed') {
          update.prLifecycleStatus = 'closed';
        }

        await db.update(workers).set(update).where(eq(workers.id, worker.id));

        await triggerEvent(channels.workspace(workspaceId), events.WORKER_PROGRESS, {
          taskId: worker.taskId,
        });

        if (didMerge && worker.taskId) {
          checkDependsOnResolved(worker.taskId).catch(err =>
            console.error(`[pr-state-refresh] checkDependsOnResolved failed for task ${worker.taskId}:`, err),
          );
        }
      } catch (err) {
        // Non-fatal: log and leave prLastCheckedAt unset so next render retries.
        console.error(`[pr-state-refresh] worker ${worker.id} PR #${worker.prNumber}:`, err);
      }
    }
  }
}
