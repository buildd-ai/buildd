import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { eq, and, or } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

/**
 * POST /api/tasks/[id]/start
 *
 * Start a pending task by notifying workers to claim it.
 * Supports dual auth: API key (Bearer) or session cookie.
 * - Broadcasts TASK_ASSIGNED event to workers
 * - Optionally targets a specific local-ui instance
 *
 * Body:
 * - targetLocalUiUrl?: string - Specific local-ui to assign to (optional)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Dual auth: API key or session
  let authType: 'api' | 'session';
  let accountId: string | null = null;
  let userId: string | null = null;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    if (!account) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }
    authType = 'api';
    accountId = account.id;
  } else {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    authType = 'session';
    userId = user.id;
  }

  const { id: taskId } = await params;

  try {
    const body = await req.json().catch(() => ({}));
    const { targetLocalUiUrl } = body;

    // Get the task
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Authorization check
    if (authType === 'session') {
      const access = await verifyWorkspaceAccess(userId!, task.workspaceId);
      if (!access) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
    } else {
      const hasAccess = await verifyAccountWorkspaceAccess(accountId!, task.workspaceId);
      if (!hasAccess) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
    }

    // Only allow starting pending tasks
    if (task.status !== 'pending') {
      return NextResponse.json({
        error: `Cannot start task with status: ${task.status}. Only pending tasks can be started.`,
        status: task.status,
      }, { status: 400 });
    }

    // Broadcast to workers
    // If targetLocalUiUrl is provided, only that worker will claim it
    // Otherwise, any available worker can claim it
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task, targetLocalUiUrl: targetLocalUiUrl || null }
    );

    return NextResponse.json({
      started: true,
      taskId: task.id,
      targetLocalUiUrl: targetLocalUiUrl || null,
    });
  } catch (error) {
    console.error('Start task error:', error);
    return NextResponse.json({ error: 'Failed to start task' }, { status: 500 });
  }
}
