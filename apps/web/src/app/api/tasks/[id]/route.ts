import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, artifacts } from '@buildd/core/db/schema';
import { and, eq, inArray, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { resolveCompletedTask } from '@/lib/task-dependencies';

// GET /api/tasks/[id] - Get a single task.
// Query params:
//   include=workers,artifacts — opt-in expansion. `workers` returns all worker
//     attempts (latest first) with PR refs, summary, error, status, branch,
//     completedAt. `artifacts` returns artifacts attached to those workers,
//     each with a shareUrl.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dev mode returns mock task data so polling doesn't break
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({
      id,
      title: 'Development mode task',
      description: null,
      status: 'pending',
      workspaceId: 'dev-workspace',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

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
      with: {
        workspace: true,
        mission: { columns: { id: true, title: true, status: true } },
      },
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

    const includeRaw = req.nextUrl.searchParams.get('include') || '';
    const include = new Set(includeRaw.split(',').map(s => s.trim()).filter(Boolean));

    let taskWorkers: any[] | undefined;
    let taskArtifacts: any[] | undefined;

    if (include.has('workers') || include.has('artifacts')) {
      taskWorkers = await db.query.workers.findMany({
        where: eq(workers.taskId, id),
        orderBy: [desc(workers.createdAt)],
        columns: {
          id: true,
          status: true,
          branch: true,
          prUrl: true,
          prNumber: true,
          error: true,
          currentAction: true,
          startedAt: true,
          completedAt: true,
          lastCommitSha: true,
          commitCount: true,
          filesChanged: true,
          linesAdded: true,
          linesRemoved: true,
          turns: true,
          inputTokens: true,
          outputTokens: true,
          costUsd: true,
          createdAt: true,
        },
      });
    }

    if (include.has('artifacts') && taskWorkers && taskWorkers.length > 0) {
      const workerIds = taskWorkers.map(w => w.id);
      const rows = await db.query.artifacts.findMany({
        where: inArray(artifacts.workerId, workerIds),
        orderBy: [desc(artifacts.updatedAt)],
      });
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://buildd.dev');
      taskArtifacts = rows.map(a => ({
        ...a,
        shareUrl: a.shareToken ? `${baseUrl}/share/${a.shareToken}` : null,
      }));
    }

    const response: Record<string, unknown> = { ...task };
    if (taskWorkers !== undefined) response.workers = taskWorkers;
    if (taskArtifacts !== undefined) response.artifacts = taskArtifacts;

    return NextResponse.json(response);
  } catch (error) {
    console.error('Get task error:', error);
    return NextResponse.json({ error: 'Failed to get task' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update a task
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dev mode returns mock
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ id, title: 'Updated Task' });
  }

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

    const body = await req.json();
    const { title, description, priority, project, missionId, dependsOn, status, roleSlug, externalIssueId, externalIssueUrl } = body;

    const updateData: Partial<typeof tasks.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (priority !== undefined) updateData.priority = priority;
    if (project !== undefined) updateData.project = project;
    if (roleSlug !== undefined) updateData.roleSlug = roleSlug || null;
    // Link (or unlink) the task to an external issue tracker item (e.g. a Linear
    // issue). Setting this is what enables the PR-merge completion comment in the
    // GitHub webhook (maybePostWorkTrackerIssueUpdate reads task.externalIssueId).
    if (externalIssueId !== undefined) updateData.externalIssueId = externalIssueId || null;
    if (externalIssueUrl !== undefined) updateData.externalIssueUrl = externalIssueUrl || null;
    if (missionId !== undefined) updateData.missionId = missionId || null;
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn) || !dependsOn.every((id: unknown) => typeof id === 'string')) {
        return NextResponse.json({ error: 'dependsOn must be an array of task IDs' }, { status: 400 });
      }
      updateData.dependsOn = dependsOn;
    }

    if (status !== undefined) {
      const allowedStatuses = ['pending', 'completed', 'failed', 'cancelled'];
      if (!allowedStatuses.includes(status)) {
        return NextResponse.json(
          { error: `Invalid status. Allowed: ${allowedStatuses.join(', ')}` },
          { status: 400 }
        );
      }
      // Only block completed/failed on active workers — cancelled bypasses this so owners
      // can kill duplicate or stuck tasks regardless of worker state.
      if (status === 'completed' || status === 'failed') {
        const activeWorker = await db.query.workers.findFirst({
          where: and(
            eq(workers.taskId, id),
            inArray(workers.status, ['running', 'waiting_input']),
          ),
        });
        if (activeWorker) {
          return NextResponse.json(
            { error: 'Cannot change status directly — task has an active worker. Use complete_task via the worker instead.' },
            { status: 409 }
          );
        }
      }
      updateData.status = status;

      // When resetting to pending, clear claim fields so the task is claimable again
      if (status === 'pending') {
        updateData.claimedBy = null;
        updateData.claimedAt = null;
        updateData.expiresAt = null;
      }
    }

    const [updated] = await db
      .update(tasks)
      .set(updateData)
      .where(eq(tasks.id, id))
      .returning();

    // When a task is cancelled, fire the mission dormancy check so missions with all
    // deliverables in terminal state auto-complete without waiting for the next heartbeat.
    if (status === 'cancelled' && updated?.missionId) {
      resolveCompletedTask(id, updated.workspaceId).catch((err) =>
        console.error('[task-patch] cancel dormancy check failed:', err)
      );
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Update task error:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id] - Delete a task (only pending tasks)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Dev mode returns success
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

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

    // ?force=true skips status check (for test cleanup scripts)
    const force = req.nextUrl.searchParams.get('force') === 'true';

    if (!force) {
      // Only allow deleting pending, assigned, failed, completed, or cancelled tasks (not actively running)
      if (!['pending', 'assigned', 'failed', 'completed', 'cancelled'].includes(task.status)) {
        return NextResponse.json(
          { error: `Cannot delete ${task.status} tasks. Wait for completion or use reassign.` },
          { status: 400 }
        );
      }
    }

    await db.delete(tasks).where(eq(tasks.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete task error:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
