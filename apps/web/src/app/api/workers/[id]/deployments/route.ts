/**
 * POST /api/workers/[id]/deployments
 *
 * Run one deployment operation for this worker's task with a stored
 * credential named by reference (docs/specs/deployment-actions.md). The
 * caller never receives the credential: the reply is a redacted result and
 * the audit row id. Backs the `deploy` MCP action.
 *
 * Authority is the task's ROLE in the task's WORKSPACE, not the caller's
 * key: the role's grant (operator-capability.ts) must cover every capability
 * the operation needs, against the named provider/project/environment/
 * credential ref. A key at worker level is enough; no admin key and no
 * `secrets:reveal` are involved.
 *
 * Auth: the API key of the account that owns the worker, or a per-task token
 * for that worker's own task. The worker must still be live.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { authenticateTaskScopedCaller, taskScopeAllowsWorker } from '@/lib/task-token-auth';
import { isUuid } from '@/lib/uuid';
import { loadOperatorGrant } from '@/lib/operator-capability-source';
import { runDeploymentAction } from '@/lib/deployments/action';
import { deploymentStore } from '@/lib/deployments/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };
const notFound = () => NextResponse.json({ error: 'Worker not found' }, { status: 404, headers: NO_STORE });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });

  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, accountId: true, workspaceId: true, taskId: true, status: true },
  });
  if (!worker || worker.accountId !== account.id || !taskScopeAllowsWorker(account, worker)) return notFound();
  if (!worker.taskId) return NextResponse.json({ error: 'This worker has no task' }, { status: 409, headers: NO_STORE });
  if (!(LIVE_WORKER_STATUSES as readonly string[]).includes(worker.status)) {
    return NextResponse.json({ error: `Worker is ${worker.status}; deployments run only from a live worker` }, { status: 409, headers: NO_STORE });
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, worker.taskId),
    columns: { id: true, workspaceId: true, roleSlug: true },
  });
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, worker.workspaceId),
    columns: { id: true, teamId: true },
  });
  if (!task || !workspace?.teamId || task.workspaceId !== workspace.id) return notFound();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400, headers: NO_STORE });
  }

  const grant = await loadOperatorGrant(workspace.id, task.roleSlug ?? '');
  const res = await runDeploymentAction(
    { kind: 'operator', grant, teamId: workspace.teamId, accountId: account.id, taskId: task.id, workerId: worker.id },
    body,
    deploymentStore,
  );
  return NextResponse.json(res.body, { status: res.status, headers: NO_STORE });
}
