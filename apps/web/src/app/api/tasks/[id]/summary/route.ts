import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

// GET /api/tasks/[id]/summary — lightweight task data for the slide-over panel
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      columns: {
        id: true,
        title: true,
        status: true,
        description: true,
        mode: true,
        roleSlug: true,
        createdAt: true,
        missionId: true,
        workspaceId: true,
        result: true,
      },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
    if (!access) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Get latest worker
    const latestWorkers = await db.query.workers.findMany({
      where: eq(workers.taskId, id),
      orderBy: desc(workers.createdAt),
      limit: 1,
      columns: {
        id: true,
        status: true,
        currentAction: true,
        turns: true,
        prUrl: true,
        prNumber: true,
        commitCount: true,
        filesChanged: true,
        costUsd: true,
        startedAt: true,
        completedAt: true,
        waitingFor: true,
        branch: true,
      },
    });

    const worker = latestWorkers[0] || null;
    const result = task.result as { summary?: string; nextSuggestion?: string } | null;

    return NextResponse.json({
      id: task.id,
      title: task.title,
      status: worker?.status === 'waiting_input' && !['completed', 'failed'].includes(task.status)
        ? 'waiting_input'
        : task.status,
      description: task.description,
      mode: task.mode,
      roleSlug: task.roleSlug,
      createdAt: task.createdAt,
      missionId: task.missionId,
      worker: worker
        ? {
            id: worker.id,
            status: worker.status,
            currentAction: worker.currentAction,
            turns: worker.turns,
            prUrl: worker.prUrl,
            prNumber: worker.prNumber,
            commitCount: worker.commitCount,
            filesChanged: worker.filesChanged,
            costUsd: worker.costUsd,
            startedAt: worker.startedAt,
            completedAt: worker.completedAt,
            waitingFor: worker.waitingFor as { type: string; prompt: string; options?: string[] } | null,
            branch: worker.branch,
          }
        : null,
      result: result
        ? {
            summary: result.summary || null,
            nextSuggestion: result.nextSuggestion || null,
          }
        : null,
    });
  } catch (error) {
    console.error('Task summary error:', error);
    return NextResponse.json({ error: 'Failed to get task summary' }, { status: 500 });
  }
}
