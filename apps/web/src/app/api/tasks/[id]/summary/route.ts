import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, workerErrorTraces } from '@buildd/core/db/schema';
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
        backend: true,
        context: true,
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
        prLifecycleStatus: true,
        mergedAt: true,
        commitCount: true,
        filesChanged: true,
        linesAdded: true,
        linesRemoved: true,
        costUsd: true,
        startedAt: true,
        completedAt: true,
        waitingFor: true,
        branch: true,
        milestones: true,
      },
    });

    const worker = latestWorkers[0] || null;
    const result = task.result as { summary?: string; nextSuggestion?: string } | null;

    // Failover metadata lives on task.context (stamped when a Claude task is
    // flipped to Codex on budget exhaustion). Surface just the display bits so
    // the panel can show "ran on Codex after Claude budget hit".
    const ctx = task.context as {
      failedOverFrom?: string;
      failoverReason?: string;
      budgetExhausted?: boolean;
    } | null;
    const failover = ctx?.failedOverFrom
      ? { from: ctx.failedOverFrom, reason: ctx.failoverReason ?? null }
      : null;

    // Latest error excerpt across all workers on this task — powers the panel's
    // "Failed" state so you see *why* it broke without opening the full page.
    const latestTraces = await db.query.workerErrorTraces.findMany({
      where: eq(workerErrorTraces.taskId, id),
      orderBy: desc(workerErrorTraces.ts),
      limit: 1,
      columns: { excerpt: true, pattern: true, ts: true },
    });
    const trace = latestTraces[0] || null;

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
      backend: task.backend,
      failover,
      worker: worker
        ? {
            id: worker.id,
            status: worker.status,
            currentAction: worker.currentAction,
            turns: worker.turns,
            prUrl: worker.prUrl,
            prNumber: worker.prNumber,
            prLifecycleStatus: worker.prLifecycleStatus,
            mergedAt: worker.mergedAt,
            commitCount: worker.commitCount,
            filesChanged: worker.filesChanged,
            linesAdded: worker.linesAdded,
            linesRemoved: worker.linesRemoved,
            costUsd: worker.costUsd,
            startedAt: worker.startedAt,
            completedAt: worker.completedAt,
            waitingFor: worker.waitingFor as { type: string; prompt: string; options?: string[] } | null,
            branch: worker.branch,
            milestones: worker.milestones ?? [],
          }
        : null,
      lastError: trace
        ? { excerpt: trace.excerpt, pattern: trace.pattern, ts: trace.ts }
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
