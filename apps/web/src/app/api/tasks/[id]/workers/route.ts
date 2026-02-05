import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

/**
 * GET /api/tasks/[id]/workers
 *
 * Get all workers for a specific task.
 * Returns workers sorted by creation date (newest first).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: taskId } = await params;

  try {
    // Get the task first to verify ownership
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Check if user owns the workspace
    if (task.workspace?.ownerId !== user.id) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Get workers for this task
    const taskWorkers = await db.query.workers.findMany({
      where: eq(workers.taskId, taskId),
      orderBy: desc(workers.createdAt),
      columns: {
        id: true,
        name: true,
        branch: true,
        status: true,
        progress: true,
        currentAction: true,
        localUiUrl: true,
        prUrl: true,
        prNumber: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    });

    return NextResponse.json({ workers: taskWorkers });
  } catch (error) {
    console.error('Get task workers error:', error);
    return NextResponse.json({ error: 'Failed to get workers' }, { status: 500 });
  }
}
