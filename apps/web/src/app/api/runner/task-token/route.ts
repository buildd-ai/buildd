import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { canMintAdminTaskToken, mintTaskToken, missingTaskTokenScopes, type TaskTokenLevel } from '@/lib/task-token';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import { isOrchestrationTask } from '@buildd/shared';

/**
 * POST /api/runner/task-token  { taskId, ttlMs?, level? } -> { token, taskId, expiresAt, level }
 *
 * A dispatcher that runs each task in its own container (apps/cloud-runner)
 * calls this with its runner key at dispatch and hands the container the
 * returned token, never the key. The token works only for that task's claim
 * and that worker's own calls (lib/task-token.ts).
 *
 * The caller must be able to claim the task itself: an account key (not a
 * per-task token, not a trigger key) that reaches the task's workspace with
 * claim permission.
 *
 * `level: 'admin'` (default `worker`) asks for an orchestration session's
 * token. Granted only when the key itself is admin (`canMintAdminTaskToken`)
 * and the task row, read here and never taken from the request, is an
 * orchestration task (`isOrchestrationTask`) in a workspace with a repo.
 * A coordination workspace's organizer creates workspaces and repos and moves
 * its mission between them, which are team-wide actions no task token
 * carries, so it is refused and keeps its runner key. Every refusal is a 403
 * naming the reason. The response echoes the level, so a caller can tell an
 * admin token from a server that ignored the field.
 */
const COORDINATION_WORKSPACE_NAME = '__coordination';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // authenticateApiKey never accepts a task token, so one cannot mint another.
  // Pass the request: without it a capability-scoped key is refused outright.
  const account = await authenticateApiKey(apiKey, req);
  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (account.level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens cannot mint task tokens.' }, { status: 403 });
  }

  // A token the key could not back would mint fine and then fail every call.
  const missing = missingTaskTokenScopes(account.scopes);
  if (missing.length > 0) {
    return NextResponse.json({ error: `This key cannot mint task tokens: it lacks ${missing.join(', ')}. Use a key with the Task agent capabilities.` }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as { taskId?: unknown; ttlMs?: unknown; level?: unknown };
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  if (!isUuid(taskId)) {
    return NextResponse.json({ error: 'taskId (UUID) is required' }, { status: 400 });
  }
  if (body.level !== undefined && body.level !== 'worker' && body.level !== 'admin') {
    return NextResponse.json({ error: "level must be 'worker' or 'admin'" }, { status: 400 });
  }
  const level: TaskTokenLevel = body.level === 'admin' ? 'admin' : 'worker';
  if (level === 'admin' && !canMintAdminTaskToken(account)) {
    return NextResponse.json({ error: 'Only an admin key can mint an admin task token.' }, { status: 403 });
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, workspaceId: true, roleSlug: true, mode: true, context: true },
    with: { workspace: { columns: { name: true, repo: true, githubRepoId: true } } },
  });
  // Same answer for a missing task and one out of reach. The body names a
  // task, not a workspace, so auth's own workspace-list check never sees it.
  if (
    !task ||
    !tokenWorkspaceAllowed(account.workspaceIds, task.workspaceId) ||
    !(await verifyAccountWorkspaceAccess(account.id, task.workspaceId, 'canClaim'))
  ) {
    void recordCapabilityDecision({ capability: 'task_token.mint', decision: 'refused', accountId: account.id, resource: `task:${taskId}`, reasonCode: 'not_found' });
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  if (level === 'admin') {
    if (!isOrchestrationTask(task)) {
      void recordCapabilityDecision({ capability: 'task_token.mint', decision: 'refused', accountId: account.id, workspaceId: task.workspaceId, taskId, reasonCode: 'admin_not_orchestration' });
      return NextResponse.json({ error: 'An admin task token is only for an orchestration task (organizer role, planning mode or heartbeat).' }, { status: 403 });
    }
    const ws = task.workspace;
    if (!ws || ws.name === COORDINATION_WORKSPACE_NAME || (!ws.repo && !ws.githubRepoId)) {
      void recordCapabilityDecision({ capability: 'task_token.mint', decision: 'refused', accountId: account.id, workspaceId: task.workspaceId, taskId, reasonCode: 'admin_no_repo_workspace' });
      return NextResponse.json({ error: 'An orchestration task in a workspace with no repo needs team-wide actions (creating a workspace or repo, moving its mission), which a task token does not carry.' }, { status: 403 });
    }
  }

  const minted = mintTaskToken({
    accountId: account.id,
    taskId,
    workspaceId: task.workspaceId,
    keyHash: account.apiKey,
    ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
    level,
  });
  if (!minted) {
    return NextResponse.json({ error: 'Task tokens are not available: no signing secret configured.' }, { status: 503 });
  }

  void recordCapabilityDecision({ capability: 'task_token.mint', decision: 'allowed', accountId: account.id, workspaceId: task.workspaceId, taskId, expiresAt: new Date(minted.expiresAt), ...(level === 'admin' ? { reasonCode: 'admin_level' } : {}) });
  return NextResponse.json({ token: minted.token, taskId, expiresAt: new Date(minted.expiresAt).toISOString(), level });
}
