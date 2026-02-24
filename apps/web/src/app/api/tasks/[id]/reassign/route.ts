import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, workerHeartbeats } from '@buildd/core/db/schema';
import { eq, and, inArray, gt, sql } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

/**
 * POST /api/tasks/[id]/reassign
 *
 * Reassign a task to any available worker.
 * - For pending tasks: broadcasts to all workers
 * - For assigned tasks: resets to pending (clears claimedBy, etc.) then broadcasts
 *
 * Query params:
 * - force=true: Force reassign even if task is assigned (requires workspace owner or stale task)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Use the authenticated account ID for ownership checks
  const authUserId = user?.id || apiAccount?.id;

  const { id: taskId } = await params;
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === 'true';

  try {
    // Get the task
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Check if user has workspace owner/admin access (required for force reassignment)
    let isWorkspaceOwner = false;
    if (user) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId, 'admin');
      isWorkspaceOwner = !!access;
    } else if (apiAccount) {
      // API accounts with workspace access can force reassign (they are service accounts)
      isWorkspaceOwner = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
    }

    // Check if task is stale (expiresAt is in the past)
    const isStale = task.expiresAt && new Date(task.expiresAt) < new Date();

    // Handle assigned tasks
    if (task.status === 'assigned') {
      // Only allow reassign if: force flag + (owner OR stale)
      if (!force) {
        return NextResponse.json({
          reassigned: false,
          reason: 'Task is assigned. Use force=true to reassign.',
          status: task.status,
          isStale,
          canTakeover: isWorkspaceOwner || isStale,
        });
      }

      if (!isWorkspaceOwner && !isStale) {
        return NextResponse.json({
          reassigned: false,
          reason: 'Cannot reassign: task is not stale and you are not the workspace owner',
          status: task.status,
          isStale,
        }, { status: 403 });
      }

      // Reset task to pending
      await db.update(tasks)
        .set({
          status: 'pending',
          claimedBy: null,
          claimedAt: null,
          expiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      // Get active workers before updating
      const activeWorkers = await db.query.workers.findMany({
        where: and(
          eq(workers.taskId, taskId),
          inArray(workers.status, ['running', 'starting', 'waiting_input', 'idle'])
        ),
      });

      // Mark all active workers as failed
      if (activeWorkers.length > 0) {
        await db.update(workers)
          .set({
            status: 'failed',
            error: 'Task was reassigned',
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(workers.taskId, taskId),
            inArray(workers.status, ['running', 'starting', 'waiting_input', 'idle'])
          ));

        // Notify each worker's channel about the failure
        for (const w of activeWorkers) {
          await triggerEvent(
            channels.worker(w.id),
            events.WORKER_FAILED,
            {
              worker: {
                ...w,
                status: 'failed',
                error: 'Task was reassigned',
                completedAt: new Date(),
              },
            }
          );
        }
      }
    } else if (task.status === 'pending') {
      // For pending tasks with force flag, require workspace ownership
      if (force && !isWorkspaceOwner) {
        return NextResponse.json({
          reassigned: false,
          reason: 'Cannot force reassign: you are not the workspace owner',
          status: task.status,
        }, { status: 403 });
      }
    } else if (task.status === 'failed') {
      // For failed tasks: reset to pending (no active workers to fail)
      await db.update(tasks)
        .set({
          status: 'pending',
          claimedBy: null,
          claimedAt: null,
          expiresAt: null,
          result: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));
    } else {
      // For completed/running tasks, don't allow reassign
      return NextResponse.json({
        reassigned: false,
        reason: `Cannot reassign task with status: ${task.status}`,
        status: task.status,
      });
    }

    // Build minimal task payload for Pusher (10KB event limit).
    // Full task data (with context, attachments, workspace config) is fetched
    // via the claim API. Sending the full object can exceed Pusher's limit.
    const taskPayload = {
      id: task.id,
      title: task.title,
      description: task.description,
      workspaceId: task.workspaceId,
      status: 'pending' as const,
      mode: task.mode,
      priority: task.priority,
    };

    // Broadcast to all workers (no targetLocalUiUrl = any worker can claim)
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task: taskPayload, targetLocalUiUrl: null }
    );

    // Check for online workers to give feedback on pickup likelihood
    const heartbeatCutoff = new Date(Date.now() - 10 * 60 * 1000);
    const onlineHeartbeats = await db
      .select({
        count: sql<number>`count(*)::int`,
        totalCapacity: sql<number>`coalesce(sum(${workerHeartbeats.maxConcurrentWorkers}), 0)::int`,
        totalActive: sql<number>`coalesce(sum(${workerHeartbeats.activeWorkerCount}), 0)::int`,
      })
      .from(workerHeartbeats)
      .where(gt(workerHeartbeats.lastHeartbeatAt, heartbeatCutoff));

    const { count: onlineRunners, totalCapacity, totalActive } = onlineHeartbeats[0] || { count: 0, totalCapacity: 0, totalActive: 0 };
    const availableCapacity = totalCapacity - totalActive;

    const response: Record<string, unknown> = {
      reassigned: true,
      taskId: task.id,
      wasAssigned: task.status === 'assigned',
      onlineRunners,
      availableCapacity,
    };

    if (onlineRunners === 0) {
      response.warning = 'No workers are currently online to pick up this task';
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('Reassign task error:', error);
    return NextResponse.json({ error: 'Failed to reassign task' }, { status: 500 });
  }
}
