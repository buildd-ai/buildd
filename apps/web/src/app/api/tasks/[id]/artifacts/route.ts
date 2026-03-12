import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, artifacts } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

// GET /api/tasks/[id]/artifacts - Get artifacts for a task
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ artifacts: [] });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Fetch task to verify access
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    columns: { id: true, workspaceId: true },
  });

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
  if (!access) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  // Get workers for this task
  const taskWorkers = await db.query.workers.findMany({
    where: eq(workers.taskId, id),
    columns: { id: true },
  });

  if (taskWorkers.length === 0) {
    return NextResponse.json({ artifacts: [] });
  }

  const workerIds = taskWorkers.map((w: { id: string }) => w.id);
  const taskArtifacts = await db.query.artifacts.findMany({
    where: inArray(artifacts.workerId, workerIds),
  });

  return NextResponse.json({ artifacts: taskArtifacts });
}
