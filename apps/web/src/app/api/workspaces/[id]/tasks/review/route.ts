import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, accounts } from '@buildd/core/db/schema';
import { eq, and, or, gte, inArray, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    if (account) return { type: 'api' as const, account };
  }

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

// GET /api/workspaces/[id]/tasks/review - Get recently completed/failed tasks for organizer review
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify workspace access
  if (auth.type === 'api') {
    const hasAccess = await verifyAccountWorkspaceAccess(auth.account.id, workspaceId, 'canClaim');
    if (!hasAccess) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  } else if (auth.type === 'session') {
    const access = await verifyWorkspaceAccess(auth.user.id, workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  try {
    const hoursBack = Math.min(
      Math.max(parseInt(req.nextUrl.searchParams.get('hoursBack') || '24', 10) || 24, 1),
      168
    );

    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    // Fetch completed/failed tasks updated in the time window
    const recentTasks = await db.query.tasks.findMany({
      where: and(
        eq(tasks.workspaceId, workspaceId),
        or(eq(tasks.status, 'completed'), eq(tasks.status, 'failed')),
        gte(tasks.updatedAt, since),
      ),
      with: {
        subTasks: {
          columns: { id: true },
        },
      },
      orderBy: (t, { desc }) => [desc(t.updatedAt)],
      limit: 50,
    });

    // Fetch the most recent worker for each task
    const taskIds = recentTasks.map(t => t.id);
    let taskWorkers: Record<string, any> = {};
    if (taskIds.length > 0) {
      const recentWorkers = await db.query.workers.findMany({
        where: inArray(workers.taskId, taskIds),
        orderBy: (w, { desc }) => [desc(w.updatedAt)],
      });
      // Group by taskId, take only the most recent worker per task
      for (const w of recentWorkers) {
        if (w.taskId && !taskWorkers[w.taskId]) {
          taskWorkers[w.taskId] = w;
        }
      }
    }

    const reviewTasks = recentTasks.map(task => ({
      id: task.id,
      title: task.title,
      description: task.description?.slice(0, 200) || null,
      status: task.status,
      mode: task.mode,
      creationSource: task.creationSource,
      parentTaskId: task.parentTaskId,
      result: task.result,
      subTaskCount: task.subTasks?.length || 0,
      updatedAt: task.updatedAt,
      worker: taskWorkers[task.id] ? {
        id: taskWorkers[task.id].id,
        status: taskWorkers[task.id].status,
        branch: taskWorkers[task.id].branch,
        prUrl: taskWorkers[task.id].prUrl,
        prNumber: taskWorkers[task.id].prNumber,
        commitCount: taskWorkers[task.id].commitCount,
        error: taskWorkers[task.id].error,
        resultMeta: taskWorkers[task.id].resultMeta,
      } : null,
    }));

    return NextResponse.json({ tasks: reviewTasks });
  } catch (error) {
    console.error('Review workspace tasks error:', error);
    return NextResponse.json({ error: 'Failed to review tasks' }, { status: 500 });
  }
}
