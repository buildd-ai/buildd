import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { getCurrentUser } from '@/lib/auth-helpers';

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
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

    // Check if user owns the workspace (admin access)
    const isWorkspaceOwner = task.workspace?.ownerId === user.id;

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
    } else if (task.status !== 'pending') {
      // For completed/failed tasks, don't allow reassign
      return NextResponse.json({
        reassigned: false,
        reason: `Cannot reassign task with status: ${task.status}`,
        status: task.status,
      });
    }

    // Refetch task after potential update
    const updatedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      with: { workspace: true },
    });

    // Broadcast to all workers (no targetLocalUiUrl = any worker can claim)
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task: updatedTask, targetLocalUiUrl: null }
    );

    return NextResponse.json({
      reassigned: true,
      taskId: task.id,
      wasAssigned: task.status === 'assigned',
    });
  } catch (error) {
    console.error('Reassign task error:', error);
    return NextResponse.json({ error: 'Failed to reassign task' }, { status: 500 });
  }
}
