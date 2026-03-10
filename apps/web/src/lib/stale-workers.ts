import { db } from '@buildd/core/db';
import { workers, tasks, workerHeartbeats } from '@buildd/core/db/schema';
import { eq, and, or, not, inArray, lt, gt } from 'drizzle-orm';
import { resolveCompletedTask } from '@/lib/task-dependencies';

/** 24 hours — how long a worker can sit in waiting_input before being cleaned up */
const WAITING_INPUT_STALE_MS = 24 * 60 * 60 * 1000;

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
  // 1. Auto-expire stale workers:
  //    - 'running'/'starting': no update in 15+ minutes
  //    - 'idle': no update in 5+ minutes (should transition almost immediately; lingering idle = runner crashed before starting)
  const STALE_THRESHOLD_MS = 15 * 60 * 1000;
  const IDLE_STALE_THRESHOLD_MS = 5 * 60 * 1000;
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const idleStaleThreshold = new Date(Date.now() - IDLE_STALE_THRESHOLD_MS);

  const staleWorkers = await db.query.workers.findMany({
    where: and(
      eq(workers.accountId, accountId),
      or(
        and(inArray(workers.status, ['running', 'starting']), lt(workers.updatedAt, staleThreshold)),
        and(eq(workers.status, 'idle'), lt(workers.updatedAt, idleStaleThreshold)),
      ),
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

      // Only reset tasks that have NO other active workers (prevents duplicate claims)
      const staleWorkerIds = staleWorkers.map(w => w.id);
      for (const t of staleTasks) {
        const otherActiveWorkers = await db.query.workers.findMany({
          where: and(
            eq(workers.taskId, t.id),
            inArray(workers.status, ['running', 'starting', 'waiting_input', 'idle']),
            not(inArray(workers.id, staleWorkerIds)),
          ),
          columns: { id: true },
          limit: 1,
        });

        if (otherActiveWorkers.length === 0) {
          await db
            .update(tasks)
            .set({
              status: 'pending',
              claimedBy: null,
              claimedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, t.id));
        }

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
        // Only reset tasks that have NO other active workers
        for (const taskId of orphanTaskIds) {
          const otherActiveWorkers = await db.query.workers.findMany({
            where: and(
              eq(workers.taskId, taskId),
              inArray(workers.status, ['running', 'starting', 'waiting_input', 'idle']),
              not(inArray(workers.id, orphanIds)),
            ),
            columns: { id: true },
            limit: 1,
          });

          if (otherActiveWorkers.length === 0) {
            await db
              .update(tasks)
              .set({
                status: 'pending',
                claimedBy: null,
                claimedAt: null,
                updatedAt: new Date(),
              })
              .where(eq(tasks.id, taskId));
          }
        }
      }
    }
  }
}

/**
 * Attempt recovery for stale workers before failing them.
 *
 * Called separately from cleanup — this tries to send a 'recover' command
 * to the runner via Pusher before giving up and marking as failed.
 *
 * Returns workers that were sent recovery commands (so cleanup can skip them).
 */
export async function attemptStaleRecovery(accountId: string): Promise<string[]> {
  const { triggerEvent, channels, events } = await import('@/lib/pusher');

  const STALE_THRESHOLD_MS = 15 * 60 * 1000;
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  // Find stale workers that haven't already been sent a recovery command
  // We use a 30-minute hard cutoff — if recovery was attempted and worker
  // is still stale after 30 minutes, let cleanup handle it
  const RECOVERY_CUTOFF_MS = 30 * 60 * 1000;
  const recoveryCutoff = new Date(Date.now() - RECOVERY_CUTOFF_MS);

  const staleWorkers = await db.query.workers.findMany({
    where: and(
      eq(workers.accountId, accountId),
      inArray(workers.status, ['running', 'starting']),
      lt(workers.updatedAt, staleThreshold),
      // Don't attempt recovery on workers that have been stale for 30+ minutes
      // (they already had their chance)
      gt(workers.updatedAt, recoveryCutoff),
    ),
    columns: { id: true, taskId: true, localUiUrl: true },
  });

  if (staleWorkers.length === 0) return [];

  const recoveredIds: string[] = [];

  for (const worker of staleWorkers) {
    try {
      // Only attempt recovery if runner has a fresh heartbeat
      if (worker.localUiUrl) {
        const heartbeat = await db.query.workerHeartbeats.findFirst({
          where: and(
            eq(workerHeartbeats.accountId, accountId),
            eq(workerHeartbeats.localUiUrl, worker.localUiUrl),
            gt(workerHeartbeats.lastHeartbeatAt, staleThreshold),
          ),
          columns: { id: true },
        });

        if (!heartbeat) continue; // Runner is dead, skip recovery
      } else {
        // No localUiUrl on the worker — check if ANY heartbeat for the account is fresh
        const anyHeartbeat = await db.query.workerHeartbeats.findFirst({
          where: and(
            eq(workerHeartbeats.accountId, accountId),
            gt(workerHeartbeats.lastHeartbeatAt, staleThreshold),
          ),
          columns: { id: true },
        });

        if (!anyHeartbeat) continue; // No live runner for this account
      }

      // Send diagnose command — the runner will inspect and report back
      await triggerEvent(
        channels.worker(worker.id),
        events.WORKER_COMMAND,
        {
          action: 'recover',
          recoveryMode: 'diagnose',
          timestamp: Date.now(),
        }
      );

      // Touch updatedAt so cleanup doesn't immediately expire it
      await db
        .update(workers)
        .set({ updatedAt: new Date() })
        .where(eq(workers.id, worker.id));

      recoveredIds.push(worker.id);
    } catch (err) {
      console.error(`[Recovery] Failed to send recover command to worker ${worker.id}:`, err);
    }
  }

  return recoveredIds;
}

/**
 * Clean up workers stuck in waiting_input for 24+ hours.
 *
 * Instead of just resetting to pending, this creates a new retry task
 * with instructions to complete without asking for user input, since
 * the original task stalled waiting for a response that never came.
 */
export async function cleanupStuckWaitingInput(): Promise<{ failedWorkers: number; retriedTasks: number }> {
  const cutoff = new Date(Date.now() - WAITING_INPUT_STALE_MS);

  const stuckWorkers = await db.query.workers.findMany({
    where: and(
      eq(workers.status, 'waiting_input'),
      lt(workers.updatedAt, cutoff),
    ),
    columns: { id: true, taskId: true, waitingFor: true },
  });

  if (stuckWorkers.length === 0) {
    return { failedWorkers: 0, retriedTasks: 0 };
  }

  let failedWorkers = 0;
  let retriedTasks = 0;

  for (const worker of stuckWorkers) {
    // Fail the worker
    await db
      .update(workers)
      .set({
        status: 'failed',
        error: 'Worker timed out waiting for user input (24+ hours)',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workers.id, worker.id));
    failedWorkers++;

    if (!worker.taskId) continue;

    // Fetch original task to clone
    const originalTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, worker.taskId),
    });

    if (!originalTask) continue;

    // Build retry description with context about what was asked
    const waitingFor = worker.waitingFor as { type?: string; prompt?: string; options?: string[] } | null;
    const waitingContext = waitingFor?.prompt
      ? `\n\n---\nPrevious attempt stalled waiting for input: "${waitingFor.prompt}"${waitingFor.options ? ` (options: ${waitingFor.options.join(', ')})` : ''}\nIMPORTANT: Do NOT ask for user input. Make reasonable decisions autonomously and proceed without blocking.`
      : '\n\n---\nIMPORTANT: Do NOT ask for user input. Make reasonable decisions autonomously and proceed without blocking.';

    const retryDescription = (originalTask.description || '') + waitingContext;

    // Fail the original task
    await db
      .update(tasks)
      .set({
        status: 'failed',
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, originalTask.id));

    // Create retry task
    await db
      .insert(tasks)
      .values({
        workspaceId: originalTask.workspaceId,
        title: originalTask.title,
        description: retryDescription,
        context: originalTask.context,
        priority: originalTask.priority,
        category: originalTask.category,
        project: originalTask.project,
        requiredCapabilities: originalTask.requiredCapabilities,
        objectiveId: originalTask.objectiveId,
        runnerPreference: originalTask.runnerPreference,
        mode: originalTask.mode,
        outputRequirement: originalTask.outputRequirement,
        outputSchema: originalTask.outputSchema,
        parentTaskId: originalTask.parentTaskId,
      })
      .returning({ id: tasks.id });

    retriedTasks++;

    // Resolve dependencies for the failed task
    await resolveCompletedTask(originalTask.id, originalTask.workspaceId);
  }

  return { failedWorkers, retriedTasks };
}
