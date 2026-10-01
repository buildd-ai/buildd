import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';

// GET /api/tasks/[id]/messages - Return instruction history for the task's latest worker
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid task id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);

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

    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const worker = await db.query.workers.findFirst({
      where: eq(workers.taskId, id),
      orderBy: desc(workers.createdAt),
      columns: { id: true, instructionHistory: true },
    });

    const messages = (worker?.instructionHistory as Array<{
      type: string;
      message: string;
      timestamp: number;
      deliveryState?: 'pending' | 'delivered';
    }> | null) ?? [];

    // Whether this caller may send, by the same rule POST /api/workers/[id]/instruct
    // applies, so the Steer canvas doesn't offer a composer whose every send 404s.
    const canSend = apiAccount && hasTokenRouteAdminAccess(apiAccount, req, 'workers:admin')
      ? apiAccount.teamId === task.workspace?.teamId
      : user ? !!(await verifyWorkspaceAccess(user.id, task.workspaceId, 'admin')) : false;

    return NextResponse.json({ taskId: id, workerId: worker?.id ?? null, canSend, messages });
  } catch (error) {
    console.error('Get task messages error:', error);
    return NextResponse.json({ error: 'Failed to get task messages' }, { status: 500 });
  }
}
