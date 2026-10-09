/**
 * /api/agent-capabilities/requests
 *
 * POST — a running agent asks for a capability semantically:
 *   Authorization: Bearer <per-task token (bldt_…) or runner API key>
 *   Body: { workerId, capability: 'observability:query' | 'model.inference', provider?, tool?,
 *           resource?, environment?, risk?, ttlSeconds?, reason?, (model.inference: models, operations?, budget) }
 * Answers with a resolution — existing | auto_granted | pending_approval | denied | forbidden |
 * need_connection | need_reauth | unhealthy | unavailable — plus next steps and alternatives,
 * and the grant row when one exists. Asking again returns the same row (deduped).
 * It never names a connector id or credential in the ask, and never returns a credential.
 *
 * GET — a signed-in team member lists the team's requests and grants
 *   (?status=pending,granted&workspaceId=…&teamId=…). Agent keys cannot list.
 *
 * Rules: lib/capability-grants.ts. Spec: docs/specs/capability-requests.md
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller, taskScopeAllowsWorker, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { resolveWorkerPrincipal } from '@/lib/agent-capabilities/worker-principal';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import { parseCapabilityRequest, GRANT_STATUSES } from '@/lib/capability-grants';
import { listTeamRequests, requestCapability } from '@/lib/capability-grants-store';
import { resolveCapabilityAdminCaller } from '@/lib/capability-grants-auth';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 16 * 1024;

function fail(status: number, error: string, code?: string) {
  return NextResponse.json({ error, ...(code ? { code } : {}) }, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return fail(401, 'Unauthorized');
  if (account.level === 'trigger') return fail(403, 'Trigger tokens cannot request capabilities');

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
    void recordCapabilityDecision({ capability: 'capability.request', decision: 'refused', accountId: account.id, principalVia, resource: `worker:${workerId}`, reasonCode: 'task_scope_mismatch' });
    return fail(404, 'Worker not found');
  }
  if (!resolved.ok) {
    void recordCapabilityDecision({ capability: 'capability.request', decision: 'refused', accountId: account.id, principalVia, resource: `worker:${workerId}`, reasonCode: resolved.reasonCode });
    return fail(resolved.status, resolved.error, resolved.status === 409 ? resolved.reasonCode : undefined);
  }
  const principal = { ...resolved.principal, via: principalVia };

  const parsed = parseCapabilityRequest(rest);
  if (!parsed.ok) return fail(400, parsed.error, 'invalid_request');

  const out = await requestCapability(principal, parsed.request);
  if (!out.ok) return fail(out.status, out.error, out.code);
  const { resolution, grant, deduped } = out;
  return NextResponse.json({
    outcome: resolution.kind,
    reasonCode: resolution.reasonCode,
    capability: parsed.request.capability,
    risk: parsed.request.risk,
    provider: resolution.target?.provider ?? null,
    connector: resolution.target?.connectorName ?? null,
    ttlSeconds: resolution.ttlSeconds || null,
    grant,
    deduped,
    nextSteps: resolution.nextSteps,
    alternatives: resolution.alternatives,
  }, { status: resolution.kind === 'auto_granted' || (resolution.kind === 'pending_approval' && !deduped) ? 201 : 200, headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const teamId = params.get('teamId');
  if (teamId && !UUID_RE.test(teamId)) return fail(400, 'invalid teamId');
  const caller = await resolveCapabilityAdminCaller(req, teamId);
  if (caller instanceof NextResponse) return caller;

  const status = (params.get('status') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (status.some(s => !(GRANT_STATUSES as readonly string[]).includes(s))) return fail(400, `status must be from ${GRANT_STATUSES.join(', ')}`);
  const workspaceId = params.get('workspaceId');
  if (workspaceId && !UUID_RE.test(workspaceId)) return fail(400, 'invalid workspaceId');
  const limit = Number(params.get('limit') ?? '50');

  const requests = await listTeamRequests(caller.teamId, { status, workspaceId, limit: Number.isFinite(limit) ? limit : 50 });
  return NextResponse.json({ teamId: caller.teamId, canDecide: caller.canManage, requests }, { headers: NO_STORE });
}
