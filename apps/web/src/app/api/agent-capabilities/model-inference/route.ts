/**
 * POST /api/agent-capabilities/model-inference
 *
 * A running agent asks buildd to answer a bounded decision (Jev's choice /
 * score / noul questions) with its team's configured decision model, under a
 * live task-scoped `model.inference` grant. buildd holds the key and picks the
 * endpoint; the response carries answers and a receipt, never a credential.
 *
 *   Authorization: Bearer <per-task token (bldt_…) or runner API key>
 *   Body: { workerId, model, operation?: 'decide', state, questions }
 *
 * The principal (live worker on its task, claimed by this account, with claim
 * authority still held) is re-resolved on every request, and a task token is
 * confined to its own task and workspace. Everything after that, including the
 * grant and budget checks that keep this fail-closed, is
 * lib/capability-model-inference.ts. Every outcome is audited.
 *
 * Spec: docs/specs/model-inference-agent-capability.md
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller, taskScopeAllowsWorker, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { resolveWorkerPrincipal } from '@/lib/agent-capabilities/worker-principal';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import {
  defaultModelInferenceDeps,
  invokeModelInference,
  parseModelInferenceRequest,
  MODEL_INFERENCE_CAPABILITY,
} from '@/lib/capability-model-inference';
import { capabilityGrantSource } from '@/lib/capability-grants-store';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };
/** Well above the adapter's state + questions ceilings; refuses a body before parsing it. */
const MAX_BODY_BYTES = 256 * 1024;

function fail(status: number, error: string, code?: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...(code ? { code } : {}), ...extra }, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return fail(401, 'Unauthorized');
  if (account.level === 'trigger') return fail(403, 'Trigger tokens cannot call models');

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return fail(413, 'Body too large', 'invalid_request');
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return fail(400, 'Invalid body', 'invalid_request');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return fail(413, 'Body too large', 'invalid_request');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'Invalid JSON body', 'invalid_request');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Body must be an object', 'invalid_request');

  const { workerId, ...rest } = body;
  if (typeof workerId !== 'string' || !ID_RE.test(workerId)) return fail(400, 'workerId is required', 'invalid_request');

  const principalVia = account.taskScope ? 'task_token' as const : 'runner_key' as const;
  const resolved = await resolveWorkerPrincipal(account, { workerId });
  // A task token reaches only its own task's worker; another task's answers as "not found".
  if (resolved.ok && !(taskScopeAllowsWorker(account, { taskId: resolved.principal.taskId })
    && taskScopeAllowsWorkspace(account, resolved.principal.workspaceId))) {
    void recordCapabilityDecision({ capability: MODEL_INFERENCE_CAPABILITY, decision: 'refused', accountId: account.id, principalVia, resource: `worker:${workerId}`, reasonCode: 'task_scope_mismatch' });
    return fail(404, 'Worker not found');
  }
  if (!resolved.ok) {
    void recordCapabilityDecision({ capability: MODEL_INFERENCE_CAPABILITY, decision: 'refused', accountId: account.id, principalVia, resource: `worker:${workerId}`, reasonCode: resolved.reasonCode });
    return fail(resolved.status, resolved.error, resolved.status === 409 ? resolved.reasonCode : undefined);
  }
  const principal = { ...resolved.principal, via: principalVia };
  const base = {
    capability: MODEL_INFERENCE_CAPABILITY, workspaceId: principal.workspaceId, taskId: principal.taskId,
    workerId: principal.workerId, accountId: principal.accountId, principalVia,
  };

  const parsed = parseModelInferenceRequest(rest);
  if (!parsed.ok) {
    void recordCapabilityDecision({ ...base, decision: 'refused', resource: `task:${principal.taskId}`, reasonCode: 'invalid_request' });
    return fail(400, parsed.error, 'invalid_request');
  }

  const deps = defaultModelInferenceDeps(row => {
    void recordCapabilityDecision({
      ...base,
      decision: row.decision,
      resource: row.grantId ? `grant:${row.grantId}` : `task:${principal.taskId}`,
      reasonCode: row.reasonCode,
      expiresAt: row.expiresAt,
      sideEffect: row.sideEffect,
    });
  });
  // Grants come from the capability request service (lib/capability-grants-store.ts);
  // the budget ledger is still NO_LEDGER, so an allowed grant is refused 503 until it lands.
  const result = await invokeModelInference(principal, parsed.request, { ...deps, grants: capabilityGrantSource });

  if (result.ok) return NextResponse.json({ answers: result.answers, receipt: result.receipt }, { headers: NO_STORE });
  if ('receipt' in result) return fail(result.status, result.error, result.code, { receipt: result.receipt });
  return fail(result.status, result.error, result.code);
}
