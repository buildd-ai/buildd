import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { eq, and, or, isNull, isNotNull, inArray } from 'drizzle-orm';
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
 * - Optionally targets a specific runner instance
 *
 * Body:
 * - targetLocalUiUrl?: string - Specific runner to assign to (optional)
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
    const { targetLocalUiUrl, forceOverride } = body;

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

    // Check the claim-route dep gate: if any dependency is completed but has an unmerged PR,
    // the claim route will silently skip this task. Surface that here before broadcasting.
    const dependsOn = (task.dependsOn as string[] | null) || [];
    if (dependsOn.length > 0 && !forceOverride) {
      const openDepWorkers = await db.query.workers.findMany({
        where: and(
          inArray(workers.taskId, dependsOn),
          isNotNull(workers.prUrl),
          isNull(workers.mergedAt),
        ),
        with: {
          task: { columns: { id: true, title: true, status: true } },
        },
        columns: { id: true, prUrl: true, prNumber: true, taskId: true },
      });

      // Only gate on dep tasks that are completed — tasks that aren't completed
      // block for a different reason (status check) and are already shown by the
      // "blocked" banner in the UI.
      const gated = openDepWorkers.filter(w => w.task?.status === 'completed');

      if (gated.length > 0) {
        return NextResponse.json({
          error: 'Task is blocked: dependency PR(s) not yet merged',
          gateReason: 'unmerged_dep_pr',
          blockingDeps: gated.map(w => ({
            taskId: w.taskId,
            taskTitle: w.task?.title || null,
            prUrl: w.prUrl,
            prNumber: w.prNumber,
          })),
          canForce: true,
        }, { status: 422 });
      }
    }

    // Human override: mark the task so the claim route bypasses the dep-PR gate.
    // This allows a human to deliberately start a task before its dependency PR merges.
    if (forceOverride && dependsOn.length > 0) {
      await db
        .update(tasks)
        .set({
          context: { ...(task.context as Record<string, unknown> || {}), bypassDepsGate: true },
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')));
    }

    // Build minimal task payload for Pusher (10KB event limit).
    // Full task data (with context, attachments, workspace config) is fetched
    // via the claim API. Sending the full object can exceed Pusher's limit
    // and cause silent delivery failure.
    const taskPayload = {
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
    };

    // Broadcast to workers
    // If targetLocalUiUrl is provided, only that worker will claim it
    // Otherwise, any available worker can claim it
    await triggerEvent(
      channels.workspace(task.workspaceId),
      events.TASK_ASSIGNED,
      { task: taskPayload, targetLocalUiUrl: targetLocalUiUrl || null }
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
