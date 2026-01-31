import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { auth } from '@/auth';

// POST /api/tasks/[id]/reassign - Admin force-reassign a stuck task
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Admin only - session auth required
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (task.status === 'completed') {
      return NextResponse.json({ error: 'Cannot reassign completed task' }, { status: 400 });
    }

    // Mark any active workers for this task as abandoned
    await db
      .update(workers)
      .set({
        status: 'failed',
        error: 'Task reassigned by admin',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workers.taskId, id),
          eq(workers.status, 'running')
        )
      );

    // Also mark idle/starting workers
    await db
      .update(workers)
      .set({
        status: 'failed',
        error: 'Task reassigned by admin',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workers.taskId, id),
          eq(workers.status, 'idle')
        )
      );

    await db
      .update(workers)
      .set({
        status: 'failed',
        error: 'Task reassigned by admin',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workers.taskId, id),
          eq(workers.status, 'starting')
        )
      );

    // Reset task to pending
    await db
      .update(tasks)
      .set({
        status: 'pending',
        claimedBy: null,
        claimedAt: null,
        expiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id));

    return NextResponse.json({
      success: true,
      message: 'Task reset to pending and available for claiming'
    });
  } catch (error) {
    console.error('Reassign task error:', error);
    return NextResponse.json({ error: 'Failed to reassign task' }, { status: 500 });
  }
}
