import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { loadQuestionWaits } from '@/lib/question-waits';
import { dependencyViewerOf } from '@/lib/task-dependency-reach';

/**
 * GET /api/tasks/[id]/question-waits
 *
 * "What waits on this" for the task's open question (Living Spec 1b257609
 * R-1 to R-4), as the caller may see it: the cards on the task page and Home
 * fetch it beside the question and render it with
 * packages/core/question-waits.ts `questionWaitsLines`. Read-only, no model.
 *
 * Body: { waits: QuestionWaits }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  let user: { id: string } | null = null;
  let account: Awaited<ReturnType<typeof authenticateApiKey>> = null;
  if (apiKey) {
    account = await authenticateApiKey(apiKey, req);
    if (!account) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  } else {
    user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: taskId } = await params;
  const task = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, taskId)), columns: { id: true, workspaceId: true } });
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  const allowed = user
    ? await verifyWorkspaceAccess(user.id, task.workspaceId)
    : await verifyAccountWorkspaceAccess(account!, task.workspaceId);
  if (!allowed) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const waits = await loadQuestionWaits({ taskId, viewer: dependencyViewerOf(user, account) });
  if (!waits) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  return NextResponse.json({ waits });
}
