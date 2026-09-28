import { NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const wsIds = await getUserWorkspaceIds(user.id);
    if (wsIds.length === 0) {
      return NextResponse.json({ tasks: [] });
    }

    // Find workers in waiting_input state for user's workspaces
    const waitingWorkers = await db.query.workers.findMany({
      where: eq(workers.status, 'waiting_input'),
      columns: { taskId: true, waitingFor: true, workspaceId: true },
    });

    // Filter to user's workspaces
    const relevantWorkers = waitingWorkers.filter(
      w => w.taskId && w.workspaceId && wsIds.includes(w.workspaceId)
    );

    if (relevantWorkers.length === 0) {
      return NextResponse.json({ tasks: [] });
    }

    const taskIds = relevantWorkers.map(w => w.taskId!);
    const waitingTasks = await db.query.tasks.findMany({
      where: inArray(tasks.id, taskIds),
      columns: { id: true, title: true, status: true, workspaceId: true, missionId: true },
    });

    const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';

    // Only include non-terminal tasks
    const activeTasks = waitingTasks
      .filter(t => t.status !== 'completed' && t.status !== 'failed')
      .map(t => {
        // A worker still holding its question wins over one already answered.
        const mine = relevantWorkers.filter(w => w.taskId === t.id);
        const worker = mine.find(w => w.waitingFor) ?? mine[0];
        return {
          id: t.id,
          title: t.title,
          workspaceId: t.workspaceId,
          // Lets the banner open the task in its mission (mission-task-href.ts).
          missionId: t.missionId ?? null,
          waitingFor: worker?.waitingFor as { type: string; prompt: string; options?: string[] } | null,
          // Answered on the resume path: `waitingFor` is cleared at once, but
          // the worker stays waiting_input until the runner resumes it. The
          // answer is on its way, so this no longer needs the person.
          answerSent: !worker?.waitingFor,
          actionUrl: `${appBaseUrl}/app/tasks/${t.id}/respond`,
        };
      });

    return NextResponse.json({ tasks: activeTasks });
  } catch (error) {
    console.error('Error fetching waiting-input tasks:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
