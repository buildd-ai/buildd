import { db } from '@buildd/core/db';
import { tasks, workers, workerHeartbeats } from '@buildd/core/db/schema';
import { reportOps } from '@buildd/core/report-ops';
import { and, lt, inArray } from 'drizzle-orm';
import { HEARTBEAT_STALE_MS } from '@/lib/stale-workers';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';

/**
 * Lightweight stale-worker cleanup: mark workers as failed when their
 * runner heartbeat expired.  Runs every cron tick (~1 min) so stale
 * workers are caught quickly instead of waiting 30 min for a runner to
 * call /api/tasks/cleanup.  Threshold matches stale-workers.ts (150 min
 * = 2.5× the 60-min poll cycle) so one missed beat doesn't kill live workers.
 *
 * Best-effort: every failure is swallowed (logged only) so the cron tick still
 * returns 200 and the scheduling work it already did is reported.
 *
 * Returns the number of orphaned workers that were failed.
 */
export async function runStaleWorkerCleanup(now: Date): Promise<number> {
  let heartbeatOrphans = 0;
  try {
    const heartbeatCutoff = new Date(now.getTime() - HEARTBEAT_STALE_MS);
    const staleHBs = await db.query.workerHeartbeats.findMany({
      where: lt(workerHeartbeats.lastHeartbeatAt, heartbeatCutoff),
      columns: { id: true, accountId: true },
    });
    if (staleHBs.length > 0) {
      const staleAccountIds = staleHBs.map(hb => hb.accountId);
      const orphanedWorkers = await db.query.workers.findMany({
        where: and(
          inArray(workers.accountId, staleAccountIds),
          inArray(workers.status, [...LIVE_WORKER_STATUSES]),
        ),
        columns: { id: true, taskId: true },
      });
      if (orphanedWorkers.length > 0) {
        await db
          .update(workers)
          .set({
            status: 'failed',
            error: 'Worker runner went offline (heartbeat expired)',
            completedAt: now,
            updatedAt: now,
          })
          .where(inArray(workers.id, orphanedWorkers.map(w => w.id)));

        const orphanTaskIds = orphanedWorkers.map(w => w.taskId).filter(Boolean) as string[];
        if (orphanTaskIds.length > 0) {
          await db
            .update(tasks)
            .set({ status: 'pending', claimedBy: null, claimedAt: null, updatedAt: now })
            .where(inArray(tasks.id, orphanTaskIds));
        }
        heartbeatOrphans = orphanedWorkers.length;
      }
      // Alert that a runner went offline — fires even when it had no active
      // workers (the orphan-failover above only covers running workers, so an
      // idle-but-wedged runner — e.g. one stuck on an unreachable server URL —
      // would otherwise vanish silently). reportOps dedups by source|message
      // for ~1h, so the per-minute cron won't spam.
      void reportOps({
        source: 'runner-offline',
        severity: 'error',
        message: 'Runner heartbeat stale — runner offline or not reaching the server',
        detail: `${staleHBs.length} stale heartbeat(s); accounts: ${[...new Set(staleAccountIds)].join(', ')}; orphaned workers failed: ${heartbeatOrphans}`,
      });
      // Delete stale heartbeat records
      await db.delete(workerHeartbeats).where(lt(workerHeartbeats.lastHeartbeatAt, heartbeatCutoff));
    }
  } catch (cleanupErr) {
    console.warn('[Cron] Stale worker cleanup failed:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
  }
  return heartbeatOrphans;
}
