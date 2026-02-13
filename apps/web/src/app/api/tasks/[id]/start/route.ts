import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { eq, and, or } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';

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
      // Session: user must own the workspace
      if (task.workspace?.ownerId !== userId) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
    } else {
      // API key: account must have access to workspace (via accountWorkspaces or open)
      const isOpen = task.workspace?.accessMode === 'open';
      if (!isOpen) {
        const link = await db.query.accountWorkspaces.findFirst({
          where: and(
            eq(accountWorkspaces.accountId, accountId!),
            eq(accountWorkspaces.workspaceId, task.workspaceId),
          ),
        });
        if (!link) {
          return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }
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
    // Note: Only send fields needed by local-ui to stay within Pusher's 10KB event limit.
    // Full task object (with workspace relation, context/attachments) can easily exceed this,
    // causing silent event delivery failure. The local-ui fetches the full task via the claim API.
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      {
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          workspaceId: task.workspaceId,
          status: task.status,
          mode: task.mode,
          priority: task.priority,
          workspace: task.workspace ? {
            name: task.workspace.name,
            repo: task.workspace.repo,
          } : undefined,
        },
        targetLocalUiUrl: targetLocalUiUrl || null,
      }
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
