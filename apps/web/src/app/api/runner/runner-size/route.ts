/**
 * POST /api/runner/runner-size
 *
 * Which container class (`standard` or `large`) the cloud runner's dispatcher
 * (apps/cloud-runner) should start a task's container in. Asked at dispatch,
 * before any container or worker exists, so this is the one runner route that
 * needs no live worker.
 *
 * Same two credentials as /api/runner/github-token, both required:
 *   Authorization: Bearer <runner API key>   an account that may claim the task
 *   X-Buildd-Dispatch-Token: <token>         the workspace's webhookConfig.token
 * The container never holds the dispatch token (nor the runner key), so it
 * cannot ask for, or choose, its own class.
 *
 * Body: { taskId, workerId? }. With `workerId` (a `task.resume`), the answer is
 * the class that worker's parked attempt ran in, from its run report, because
 * the parked state lives in that class's agent. Otherwise it is the
 * workspace's effective size (lib/runner-size.ts): explicit
 * `gitConfig.runnerSize`, else derived from recent run reports and stored the
 * first time it derives `large`.
 *
 * Response: { taskId, workspaceId, runnerSize, source: explicit|derived|default|pinned, reason }.
 * workspaceId keys the cloud runner's container reuse (apps/cloud-runner
 * container-lease.ts): a warm container only ever goes to the same workspace.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveDispatchTask } from '@/lib/agent-capabilities/dispatch-principal';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import { resolveWorkspaceRunnerSize, runnerSizeOfWorker } from '@/lib/runner-size-store';

import { resolveWorkspaceWarmHandover } from '@/lib/warm-handover-store';

/** Mirrors DISPATCH_TOKEN_HEADER in apps/cloud-runner/src/outbound.ts. */
const DISPATCH_TOKEN_HEADER = 'x-buildd-dispatch-token';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return fail(401, 'Unauthorized');
  if (account.level === 'trigger') return fail(403, 'Trigger tokens cannot ask for a runner size');

  const dispatchToken = req.headers.get(DISPATCH_TOKEN_HEADER);
  if (!dispatchToken) return fail(401, 'Dispatch token required');

  let body: { taskId?: unknown; workerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  const { taskId, workerId } = body ?? {};
  if (typeof taskId !== 'string' || !ID_RE.test(taskId)) return fail(400, 'taskId is required');
  if (workerId !== undefined && (typeof workerId !== 'string' || !ID_RE.test(workerId))) {
    return fail(400, 'workerId must be an id');
  }

  const resolved = await resolveDispatchTask(account, { taskId, dispatchToken });
  if (!resolved.ok) {
    void recordCapabilityDecision({ capability: 'runner.size', decision: 'refused', accountId: account.id, principalVia: 'dispatch', resource: `task:${taskId}`, reasonCode: resolved.reasonCode });
    return fail(resolved.status, resolved.error);
  }
  const ws = resolved.workspace;
  const warmHandover = await resolveWorkspaceWarmHandover(ws);

  if (typeof workerId === 'string') {
    const pinned = await runnerSizeOfWorker(ws.id, workerId);
    if (pinned) return NextResponse.json({ taskId, workspaceId: ws.id, warmHandover, runnerSize: pinned, source: 'pinned', reason: null }, { headers: NO_STORE });
  }

  const decision = await resolveWorkspaceRunnerSize(ws, { persist: true });
  return NextResponse.json(
    { taskId, workspaceId: ws.id, warmHandover, runnerSize: decision.size, source: decision.source, reason: decision.reason },
    { headers: NO_STORE },
  );
}
