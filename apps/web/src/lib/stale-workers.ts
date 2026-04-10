import { db } from '@buildd/core/db';
import { workers, tasks, workerHeartbeats } from '@buildd/core/db/schema';
import { eq, and, or, not, inArray, lt, gt } from 'drizzle-orm';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import { checkWorkerDeliverables, getWorkerArtifactCount } from '@/lib/worker-deliverables';

/** Maximum number of failed worker attempts before a task is permanently failed */
const MAX_WORKER_RETRIES = 3;

/** 24 hours — how long a standalone worker can sit in waiting_input before being cleaned up */
const WAITING_INPUT_STALE_MS = 24 * 60 * 60 * 1000;

/** 4 hours — shorter timeout for mission tasks since missions are time-sensitive */
const WAITING_INPUT_MISSION_STALE_MS = 4 * 60 * 60 * 1000;

/**
 * Decide what to do with a task whose worker just died:
 * 1. If the worker produced deliverables → promote to completed
 * 2. If retry cap reached (3+ failed workers) → fail permanently
 * 3. Otherwise → reset to pending for another attempt
 *
 * Always resolves dependencies afterward.
 */
async function resolveStaleTask(
  taskId: string,
  workspaceId: string,
  staleWorker: { id: string; prUrl: string | null; prNumber: number | null; commitCount: number | null; branch: string | null; error: string | null } | undefined,
) {
  // Check if the stale worker produced deliverables
  let hasDeliverables = false;
  if (staleWorker) {
    try {
      const artifactCount = await getWorkerArtifactCount(staleWorker.id);
      const deliverables = checkWorkerDeliverables(staleWorker, { artifactCount });
      hasDeliverables = deliverables.hasAny;
    } catch { /* non-fatal — default to pending */ }
  }

  if (hasDeliverables) {
    await db
      .update(tasks)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
  } else {
    // Count how many workers have already failed on this task
    const failedWorkers = await db.query.workers.findMany({
      where: and(
        eq(workers.taskId, taskId),
        eq(workers.status, 'failed'),
      ),
      columns: { id: true },
    });

    if (failedWorkers.length >= MAX_WORKER_RETRIES) {
      // Retry cap reached — permanently fail the task
      await db
        .update(tasks)
        .set({
          status: 'failed',
          result: { error: `Task failed after ${failedWorkers.length} worker attempts` } as any,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));
    } else {
      // Retries remaining — reset to pending, preserving branch context for continuity
      const currentTask = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: { context: true },
      });
      const existingCtx = (currentTask?.context || {}) as Record<string, unknown>;
      await db
        .update(tasks)
        .set({
          status: 'pending',
          claimedBy: null,
          claimedAt: null,
          context: {
            ...existingCtx,
            ...(staleWorker?.branch ? { baseBranch: staleWorker.branch } : {}),
            failureContext: staleWorker?.error || 'Previous worker expired',
          },
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));
    }
  }

  await resolveCompletedTask(taskId, workspaceId);
}

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
    columns: { id: true, taskId: true, prUrl: true, prNumber: true, commitCount: true, branch: true, error: true },
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
          const staleWorker = staleWorkers.find(w => w.taskId === t.id);
          await resolveStaleTask(t.id, t.workspaceId, staleWorker);
        } else {
          await resolveCompletedTask(t.id, t.workspaceId);
        }
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
      columns: { id: true, taskId: true, prUrl: true, prNumber: true, commitCount: true, branch: true, error: true },
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
        // Fetch workspace IDs for dependency resolution
        const orphanTasks = await db.query.tasks.findMany({
          where: inArray(tasks.id, orphanTaskIds),
          columns: { id: true, workspaceId: true },
        });

        // Only reset tasks that have NO other active workers
        for (const task of orphanTasks) {
          const otherActiveWorkers = await db.query.workers.findMany({
            where: and(
              eq(workers.taskId, task.id),
              inArray(workers.status, ['running', 'starting', 'waiting_input', 'idle']),
              not(inArray(workers.id, orphanIds)),
            ),
            columns: { id: true },
            limit: 1,
          });

          if (otherActiveWorkers.length === 0) {
            const orphanWorker = orphanedByHeartbeat.find(w => w.taskId === task.id);
            await resolveStaleTask(task.id, task.workspaceId, orphanWorker);
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
  // Fetch all waiting workers past the shorter (mission) threshold, then filter
  const missionCutoff = new Date(Date.now() - WAITING_INPUT_MISSION_STALE_MS);
  const standaloneCutoff = new Date(Date.now() - WAITING_INPUT_STALE_MS);

  const allWaitingWorkers = await db.query.workers.findMany({
    where: and(
      eq(workers.status, 'waiting_input'),
      lt(workers.updatedAt, missionCutoff),
    ),
    columns: { id: true, taskId: true, waitingFor: true, updatedAt: true, branch: true, error: true },
    with: { task: { columns: { missionId: true } } },
  });

  // Mission tasks use 4h timeout, standalone tasks use 24h timeout
  const stuckWorkers = allWaitingWorkers.filter(w => {
    const isMissionTask = !!(w as any).task?.missionId;
    if (isMissionTask) return true; // Already past 4h cutoff
    return w.updatedAt < standaloneCutoff;
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
        error: `Worker timed out waiting for user input (${(worker as any).task?.missionId ? '4' : '24'}+ hours)`,
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

    // Create retry task with enriched context for branch continuity
    const existingCtx = (originalTask.context || {}) as Record<string, unknown>;
    const retryContext = {
      ...existingCtx,
      ...(worker.branch ? { baseBranch: worker.branch } : {}),
      failureContext: worker.error || 'Worker stalled in waiting_input',
      iteration: ((existingCtx.iteration as number) || 0) + 1,
    };

    await db
      .insert(tasks)
      .values({
        workspaceId: originalTask.workspaceId,
        title: originalTask.title,
        description: retryDescription,
        context: retryContext,
        priority: originalTask.priority,
        category: originalTask.category,
        project: originalTask.project,
        requiredCapabilities: originalTask.requiredCapabilities,
        missionId: originalTask.missionId,
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
