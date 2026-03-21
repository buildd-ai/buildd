import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

// POST /api/tasks/[id]/reject-plan - Reject a planning task's plan and create a revised planning task
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify access
    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Validate task state
    if (task.mode !== 'planning') {
      return NextResponse.json({ error: 'Task is not a planning task' }, { status: 400 });
    }

    if (task.status !== 'completed') {
      return NextResponse.json({ error: 'Planning task has not completed yet' }, { status: 400 });
    }

    const body = await req.json();
    const { feedback } = body;

    if (!feedback || typeof feedback !== 'string') {
      return NextResponse.json({ error: 'Feedback is required' }, { status: 400 });
    }

    // Create a new planning task with feedback context
    const existingContext = (task.context as Record<string, unknown>) || {};

    const [newTask] = await db
      .insert(tasks)
      .values({
        workspaceId: task.workspaceId,
        title: task.title + ' (revised)',
        description: task.description,
        mode: 'planning',
        status: 'pending',
        creationSource: 'api',
        parentTaskId: task.parentTaskId,
        missionId: task.missionId,
        priority: task.priority,
        context: {
          ...existingContext,
          planFeedback: feedback,
          previousPlanTaskId: id,
        },
      })
      .returning();

    return NextResponse.json({ taskId: newTask.id });
  } catch (error) {
    console.error('Reject plan error:', error);
    return NextResponse.json({ error: 'Failed to reject plan' }, { status: 500 });
  }
}
