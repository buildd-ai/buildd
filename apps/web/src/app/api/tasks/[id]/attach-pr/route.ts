import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { attachPrToTask, parsePrReference, resolveWorkspaceGithubRepo } from '@/lib/task-pr-attach';

const FULL_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/tasks/[id]/attach-pr
 *
 * Record the PR that delivered a task closed without a worker (e.g. by
 * `update_task status=completed`), so the mission page lists it and mission
 * completion can see it. Body: `{ prUrl?, prNumber? }` — one is required.
 *
 * The PR is read through the workspace's GitHub App before anything is written,
 * then mapped to the task with an `external` placeholder worker exactly as PR
 * adoption does (see `@/lib/task-pr-attach`). Like correcting a result summary,
 * this rewrites a finished task's record, so an API key must be admin-level.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req, 'tasks:admin')) {
    return NextResponse.json({ error: 'Attaching a PR to a task requires an admin-level token' }, { status: 403 });
  }

  if (!FULL_UUID_REGEX.test(id)) {
    return NextResponse.json({ error: `taskId must be a full UUID — received "${id}"` }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    with: { workspace: true },
  });
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const hasAccess = apiAccount
    ? await verifyAccountWorkspaceAccess(apiAccount.id, task.workspaceId)
    : await verifyWorkspaceAccess(user!.id, task.workspaceId);
  if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  // A live or queued task gets its PR from its own worker; attaching one here
  // would race it.
  if (!['completed', 'failed'].includes(task.status)) {
    return NextResponse.json(
      { error: `Cannot attach a PR to a '${task.status}' task — only a completed or failed task` },
      { status: 400 },
    );
  }

  const repo = await resolveWorkspaceGithubRepo(task.workspace ?? {});
  if (!repo) {
    return NextResponse.json({ error: "This task's workspace is not linked to a GitHub repo" }, { status: 400 });
  }

  const ref = parsePrReference(body as { prUrl?: unknown; prNumber?: unknown }, repo.fullName);
  if ('error' in ref) return NextResponse.json({ error: ref.error }, { status: 400 });

  const outcome = await attachPrToTask({
    task: { id: task.id, workspaceId: task.workspaceId, result: task.result },
    repo,
    prNumber: ref.prNumber,
    accountId: apiAccount?.id ?? null,
  });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });

  return NextResponse.json({
    ok: true,
    taskId: task.id,
    title: task.title,
    alreadyAttached: outcome.alreadyAttached,
    workerId: outcome.workerId,
    prNumber: outcome.prNumber,
    prUrl: outcome.prUrl,
    prState: outcome.prState,
    result: outcome.result,
  });
}
