import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks, workerHeartbeats } from '@buildd/core/db/schema';
import { eq, and, lt, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { cleanupStaleWorkers } from '@/lib/stale-workers';

// POST /api/tasks/cleanup - Clean up stale workers and orphaned tasks
// Admin auth only (session or admin-level API key)
export async function POST(req: NextRequest) {
  // Auth check: session or admin API key
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  const hasSessionAuth = !!user;
  const hasAdminToken = apiAccount?.level === 'admin';

  if (!hasSessionAuth && !hasAdminToken) {
    return NextResponse.json(
      { error: 'Unauthorized - requires session auth or admin-level API token' },
      { status: 401 }
    );
  }

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  let stalledWorkers = 0;
  let orphanedTasks = 0;

  // 1. Workers stuck in running/starting with no update for > 1 hour
  const stalledRunning = await db.query.workers.findMany({
    where: and(
      inArray(workers.status, ['running', 'starting']),
      lt(workers.updatedAt, oneHourAgo)
    ),
    columns: { id: true, taskId: true },
  });

  if (stalledRunning.length > 0) {
    const stalledWorkerIds = stalledRunning.map(w => w.id);
    const stalledTaskIds = stalledRunning.map(w => w.taskId).filter(Boolean) as string[];

    await db
      .update(workers)
      .set({
        status: 'failed',
        error: 'Worker timed out - no activity for over 1 hour',
        completedAt: now,
        updatedAt: now,
      })
      .where(inArray(workers.id, stalledWorkerIds));

    // Reset associated tasks to pending so they can be re-claimed
    if (stalledTaskIds.length > 0) {
      await db
        .update(tasks)
        .set({
          status: 'pending',
          claimedBy: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(and(
          inArray(tasks.id, stalledTaskIds),
          eq(tasks.status, 'assigned'),
        ));
    }

    stalledWorkers = stalledRunning.length;
  }

  // 2. Tasks stuck in 'assigned' with no active workers — reconcile with worker status
  const assignedTasks = await db.query.tasks.findMany({
    where: eq(tasks.status, 'assigned'),
  });

  for (const task of assignedTasks) {
    const taskWorkers = await db.query.workers.findMany({
      where: eq(workers.taskId, task.id),
      columns: { id: true, status: true, prUrl: true, prNumber: true, commitCount: true, filesChanged: true, linesAdded: true, linesRemoved: true, lastCommitSha: true, branch: true },
    });

    // Check for active workers
    const hasActive = taskWorkers.some(w =>
      ['running', 'starting', 'waiting_input', 'idle'].includes(w.status)
    );

    if (hasActive) continue;

    // Check if any worker completed — promote task to completed
    const completedWorker = taskWorkers.find(w => w.status === 'completed');
    if (completedWorker) {
      await db
        .update(tasks)
        .set({
          status: 'completed',
          result: {
            branch: completedWorker.branch,
            commits: completedWorker.commitCount ?? 0,
            sha: completedWorker.lastCommitSha ?? undefined,
            files: completedWorker.filesChanged ?? 0,
            added: completedWorker.linesAdded ?? 0,
            removed: completedWorker.linesRemoved ?? 0,
            prUrl: completedWorker.prUrl ?? undefined,
            prNumber: completedWorker.prNumber ?? undefined,
          },
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
      orphanedTasks++;
      continue;
    }

    // No active workers, no completed workers — reset to pending if stale enough
    if (task.updatedAt < twoHoursAgo) {
      await db
        .update(tasks)
        .set({
          status: 'pending',
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
      orphanedTasks++;
    }
  }

  // 3. Per-account stale worker cleanup (15-min threshold + heartbeat check)
  const activeAccountIds = await db.query.workers.findMany({
    where: inArray(workers.status, ['running', 'starting', 'idle', 'waiting_input']),
    columns: { accountId: true },
  });
  const uniqueAccountIds = [...new Set(activeAccountIds.map(w => w.accountId).filter(Boolean))] as string[];
  for (const accountId of uniqueAccountIds) {
    try {
      await cleanupStaleWorkers(accountId);
    } catch {
      // Non-fatal — continue with other accounts
    }
  }

  // 4. Mark workers as failed when their local-UI heartbeat is stale
  // This catches workers that appear active but their runner machine is offline
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
  let heartbeatOrphans = 0;

  const staleHeartbeats = await db.query.workerHeartbeats.findMany({
    where: lt(workerHeartbeats.lastHeartbeatAt, tenMinutesAgo),
    columns: { id: true, accountId: true },
  });

  if (staleHeartbeats.length > 0) {
    const staleAccountIds = staleHeartbeats.map(hb => hb.accountId);

    // Find active workers belonging to accounts with stale heartbeats
    const orphanedWorkers = await db.query.workers.findMany({
      where: and(
        inArray(workers.accountId, staleAccountIds),
        inArray(workers.status, ['running', 'starting', 'idle', 'waiting_input']),
      ),
      columns: { id: true, taskId: true },
    });

    if (orphanedWorkers.length > 0) {
      const orphanWorkerIds = orphanedWorkers.map(w => w.id);
      const orphanTaskIds = orphanedWorkers.map(w => w.taskId).filter(Boolean) as string[];

      await db
        .update(workers)
        .set({
          status: 'failed',
          error: 'Worker runner went offline (heartbeat expired)',
          completedAt: now,
          updatedAt: now,
        })
        .where(inArray(workers.id, orphanWorkerIds));

      // Reset associated tasks to pending so they can be re-claimed
      if (orphanTaskIds.length > 0) {
        await db
          .update(tasks)
          .set({
            status: 'pending',
            claimedBy: null,
            claimedAt: null,
            updatedAt: now,
          })
          .where(inArray(tasks.id, orphanTaskIds));
      }

      heartbeatOrphans = orphanedWorkers.length;
    }
  }

  // 6. Delete stale heartbeats (no ping for > 10 minutes)
  const deletedHeartbeats = await db
    .delete(workerHeartbeats)
    .where(lt(workerHeartbeats.lastHeartbeatAt, tenMinutesAgo))
    .returning({ id: workerHeartbeats.id });

  return NextResponse.json({
    cleaned: {
      stalledWorkers,
      orphanedTasks,
      heartbeatOrphans,
      staleHeartbeats: deletedHeartbeats.length,
    },
  });
}
