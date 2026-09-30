import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { mintTaskToken } from '@/lib/task-token';

/**
 * POST /api/runner/task-token  { taskId, ttlMs? } -> { token, taskId, expiresAt }
 *
 * A dispatcher that runs each task in its own container (apps/cloud-runner)
 * calls this with its runner key at dispatch and hands the container the
 * returned token, never the key. The token works only for that task's claim
 * and that worker's own calls (lib/task-token.ts).
 *
 * The caller must be able to claim the task itself: an account key (not a
 * per-task token, not a trigger key) that reaches the task's workspace with
 * claim permission.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // authenticateApiKey never accepts a task token, so one cannot mint another.
  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (account.level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens cannot mint task tokens.' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as { taskId?: unknown; ttlMs?: unknown };
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  if (!isUuid(taskId)) {
    return NextResponse.json({ error: 'taskId (UUID) is required' }, { status: 400 });
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, workspaceId: true },
  });
  // Same answer for a missing task and one out of reach.
  if (!task || !(await verifyAccountWorkspaceAccess(account.id, task.workspaceId, 'canClaim'))) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const minted = mintTaskToken({
    accountId: account.id,
    taskId,
    workspaceId: task.workspaceId,
    keyHash: account.apiKey,
    ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
  });
  if (!minted) {
    return NextResponse.json({ error: 'Task tokens are not available: no signing secret configured.' }, { status: 503 });
  }

  return NextResponse.json({ token: minted.token, taskId, expiresAt: new Date(minted.expiresAt).toISOString() });
}
