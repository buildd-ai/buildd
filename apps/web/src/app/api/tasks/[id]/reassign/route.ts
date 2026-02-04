import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { getCurrentUser } from '@/lib/auth-helpers';

/**
 * POST /api/tasks/[id]/reassign
 *
 * Reassign a task to any available worker after the original assignment times out.
 * Broadcasts task:assigned to all workers without a target, so anyone can claim it.
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

  try {
    // Get the task
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Only reassign if still pending (not already claimed)
    if (task.status !== 'pending') {
      return NextResponse.json({
        reassigned: false,
        reason: 'Task already claimed',
        status: task.status,
      });
    }

    // Broadcast to all workers (no targetLocalUiUrl = any worker can claim)
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task, targetLocalUiUrl: null }
    );

    return NextResponse.json({
      reassigned: true,
      taskId: task.id,
    });
  } catch (error) {
    console.error('Reassign task error:', error);
    return NextResponse.json({ error: 'Failed to reassign task' }, { status: 500 });
  }
}
