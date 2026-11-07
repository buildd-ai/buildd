/**
 * POST /api/agent-capabilities/requests/[id]/withdraw
 *   Authorization: Bearer <per-task token (bldt_…) or runner API key>
 *   Body: { workerId }
 *
 * The requesting agent withdraws its own pending access request (MCP
 * `withdraw_capability_request`): the row closes as `expired`, decided by
 * `agent`, reason `withdrawn`, and the person's card drops. Only the worker
 * that made the request may withdraw it; another worker's answers 404. A
 * granted request is not withdrawn (409 `already_granted`: the agent has it),
 * and a decided one answers 409 with its status. Repeating a withdraw is 200.
 *
 * Rules: lib/capability-hold.ts. Spec: docs/specs/capability-requests.md → Holding the run.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller, taskScopeAllowsWorker, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { resolveWorkerPrincipal } from '@/lib/agent-capabilities/worker-principal';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import { withdrawCapabilityRequest } from '@/lib/capability-hold-store';
import { isUuid } from '@/lib/uuid';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string, code?: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...(code ? { code } : {}), ...extra }, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return fail(401, 'Unauthorized');
  if (account.level === 'trigger') return fail(403, 'Trigger tokens cannot withdraw capability requests');
  if (!isUuid(id)) return fail(404, 'Request not found', 'not_found');

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid JSON body', 'invalid_request');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Body must be an object', 'invalid_request');
  const workerId = body.workerId;
  if (typeof workerId !== 'string' || !ID_RE.test(workerId)) return fail(400, 'workerId is required', 'invalid_request');

  const principalVia = account.taskScope ? 'task_token' as const : 'runner_key' as const;
  const resolved = await resolveWorkerPrincipal(account, { workerId });
  // A task token reaches only its own task's worker; another task's answers as "not found".
  if (resolved.ok && !(taskScopeAllowsWorker(account, { taskId: resolved.principal.taskId })
    && taskScopeAllowsWorkspace(account, resolved.principal.workspaceId))) {
    void recordCapabilityDecision({ capability: 'capability.withdraw', decision: 'refused', accountId: account.id, principalVia, resource: `worker:${workerId}`, reasonCode: 'task_scope_mismatch' });
    return fail(404, 'Worker not found');
  }
  if (!resolved.ok) {
    void recordCapabilityDecision({ capability: 'capability.withdraw', decision: 'refused', accountId: account.id, principalVia, resource: `worker:${workerId}`, reasonCode: resolved.reasonCode });
    return fail(resolved.status, resolved.error, resolved.status === 409 ? resolved.reasonCode : undefined);
  }

  const out = await withdrawCapabilityRequest({ ...resolved.principal, via: principalVia }, id);
  if (!out.ok) return fail(out.status, out.error, out.code, out.requestStatus ? { requestStatus: out.requestStatus } : {});
  return NextResponse.json({
    requestId: out.requestId, status: out.status, alreadyClosed: out.alreadyClosed,
    nextSteps: ['The request is closed; the person is no longer asked. When you complete, say what the result lacks without it: structuredOutput.proceededWithout { requestId, whatIsMissing }.'],
  }, { headers: NO_STORE });
}
