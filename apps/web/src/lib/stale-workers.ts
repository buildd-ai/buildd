import { db } from '@buildd/core/db';
import { workers, tasks, workerHeartbeats } from '@buildd/core/db/schema';
import { eq, and, inArray, lt, gt } from 'drizzle-orm';
import { resolveCompletedTask } from '@/lib/task-dependencies';

/**
 * Clean up stale workers for a specific account.
 *
 * 1. Expire workers with no update for 15+ minutes
 * 2. Expire workers whose runner's heartbeat is stale (10+ minutes)
 *
 * Extracted from the claim route so it can also be called from the
 * periodic cleanup endpoint — important now that heartbeat-driven
 * claiming is removed and claim is called less frequently.
 */
export async function cleanupStaleWorkers(accountId: string) {
  // 1. Auto-expire stale workers (no update in 15+ minutes)
  const STALE_THRESHOLD_MS = 15 * 60 * 1000;
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  const staleWorkers = await db.query.workers.findMany({
    where: and(
      eq(workers.accountId, accountId),
      inArray(workers.status, ['running', 'starting', 'waiting_input']),
      lt(workers.updatedAt, staleThreshold)
    ),
    columns: { id: true, taskId: true },
  });

  if (staleWorkers.length > 0) {
    const staleWorkerIds = staleWorkers.map(w => w.id);
    const staleTaskIds = staleWorkers.map(w => w.taskId).filter(Boolean) as string[];

    await db
      .update(workers)
      .set({
        status: 'failed',
        error: 'Stale worker expired (no update for 15+ minutes)',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(workers.id, staleWorkerIds));

    if (staleTaskIds.length > 0) {
      // Fetch workspace IDs before updating, for dependency resolution
      const staleTasks = await db.query.tasks.findMany({
        where: inArray(tasks.id, staleTaskIds),
        columns: { id: true, workspaceId: true },
      });

      await db
        .update(tasks)
        .set({
          status: 'pending',
          claimedBy: null,
          claimedAt: null,
          updatedAt: new Date(),
        })
        .where(inArray(tasks.id, staleTaskIds));

      // Resolve dependencies for expired tasks
      for (const t of staleTasks) {
        await resolveCompletedTask(t.id, t.workspaceId);
      }
    }
  }

  // 2. Fail active workers when their runner's heartbeat is stale (machine went offline)
  const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
  const heartbeatCutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);

  const freshHeartbeat = await db.query.workerHeartbeats.findFirst({
    where: and(
      eq(workerHeartbeats.accountId, accountId),
      gt(workerHeartbeats.lastHeartbeatAt, heartbeatCutoff),
    ),
    columns: { id: true },
  });

  if (!freshHeartbeat) {
    const orphanedByHeartbeat = await db.query.workers.findMany({
      where: and(
        eq(workers.accountId, accountId),
        inArray(workers.status, ['running', 'starting', 'idle', 'waiting_input']),
        lt(workers.updatedAt, heartbeatCutoff),
      ),
      columns: { id: true, taskId: true },
    });

    if (orphanedByHeartbeat.length > 0) {
      const orphanIds = orphanedByHeartbeat.map(w => w.id);
      const orphanTaskIds = orphanedByHeartbeat.map(w => w.taskId).filter(Boolean) as string[];

      await db
        .update(workers)
        .set({
          status: 'failed',
          error: 'Worker runner went offline (heartbeat expired)',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(inArray(workers.id, orphanIds));

      if (orphanTaskIds.length > 0) {
        await db
          .update(tasks)
          .set({
            status: 'pending',
            claimedBy: null,
            claimedAt: null,
            updatedAt: new Date(),
          })
          .where(inArray(tasks.id, orphanTaskIds));
      }
    }
  }
}
