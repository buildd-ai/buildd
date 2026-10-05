/**
 * POST /api/runner/model-endpoint
 *
 * The team's agent model endpoint for ONE cloud task, for the cloud runner's
 * dispatcher (apps/cloud-runner). The dispatcher's egress handler applies it
 * to the container's model requests; the container never receives it (the
 * claim strips `modelEndpoint` for `executor: 'cloud'`).
 *
 * Auth is exactly /api/runner/github-token's:
 *   Authorization: Bearer <runner API key>   the account that claimed the task
 *   X-Buildd-Dispatch-Token: <token>         the workspace's webhookConfig.token
 * The container holds the API key but never the dispatch token.
 *
 * Body: { taskId, workerId? }. Refused unless the task's workspace is one the
 * account may claim from, the dispatch token matches that workspace's enabled
 * webhook, and the task has a live worker owned by the calling account (and,
 * when workerId is given, it is that worker).
 *
 * Applies the same ranking as the claim (packages/core/agent-endpoint.ts,
 * `resolveAgentModelRoute`): when an `agent_endpoint` wins, that is what
 * comes back. When it loses (or none exists) and the task's own Anthropic
 * credential is a plain `anthropic_api_key` — resolved with
 * `resolveAnthropicAuth`, the same scoping a self-hosted runner would use
 * (docs/credentials-architecture.md) — that key comes back too, flagged
 * `source: 'anthropic_api_key'` so the dispatcher's egress handler ranks it
 * ahead of its own `MODEL_PROXY_URL` override (apps/cloud-runner/src/outbound.ts
 * `resolveModelRoute`): the key is the team's own metered credential, not an
 * opt-in to any proxy, so a Worker-level pin must not silently spend it on a
 * different route. An OAuth seat or Claude credential winning the ranking
 * still gets 404 — cloud egress does not carry a seat token. A codex task, or
 * a team with nothing at all, is also 404 and egress falls through to the
 * Worker's own route.
 *
 * Design: docs/design/agent-model-endpoint.md §3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveAgentModelRoute } from '@buildd/core/agent-endpoint';
import { resolveAnthropicAuth } from '@/lib/claude-credential';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveDispatchPrincipal } from '@/lib/agent-capabilities/dispatch-principal';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';

/** Mirrors DISPATCH_TOKEN_HEADER in apps/cloud-runner/src/outbound.ts. */
const DISPATCH_TOKEN_HEADER = 'x-buildd-dispatch-token';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  // Pass the request: without it a capability-scoped key is refused outright.
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return fail(401, 'Unauthorized');
  if (account.level === 'trigger') return fail(403, 'Trigger tokens cannot request a model endpoint');

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

  const resolved = await resolveDispatchPrincipal(account, { taskId, workerId, dispatchToken });
  if (!resolved.ok) {
    void recordCapabilityDecision({ capability: 'model.endpoint', decision: 'refused', accountId: account.id, principalVia: 'dispatch', resource: `task:${taskId}`, reasonCode: resolved.reasonCode });
    return fail(resolved.status, resolved.error);
  }
  const { task, workspace: ws } = resolved;
  const p = resolved.principal;
  const audit = { capability: 'model.endpoint' as const, workspaceId: p.workspaceId, taskId: p.taskId, workerId: p.workerId, accountId: p.accountId, principalVia: p.via };

  // Codex speaks the OpenAI Responses API with its own credential (§2).
  if ((task as { backend?: string | null }).backend === 'codex') return fail(404, 'No agent model endpoint for this task');

  try {
    const decision = await resolveAgentModelRoute({ teamId: ws.teamId, workspaceId: ws.id, accountId: account.id });
    if (decision && decision.winner === 'endpoint') {
      const e = decision.endpoint;
      void recordCapabilityDecision({ ...audit, decision: 'allowed', resource: `agent_endpoint:${e.kind}` });
      return NextResponse.json(
        { kind: e.kind, baseUrl: e.baseUrl, key: e.apiKey, authHeader: e.authHeader, models: e.models },
        { headers: NO_STORE },
      );
    }
    // The endpoint lost the ranking (or none exists). Only a plain Anthropic
    // API key reaches cloud egress from here — an OAuth seat or Claude
    // credential winning still falls through to 404, same as before.
    const auth = await resolveAnthropicAuth({ teamId: ws.teamId, workspaceId: ws.id });
    if (auth && auth.purpose === 'anthropic_api_key') {
      void recordCapabilityDecision({ ...audit, decision: 'allowed', resource: 'anthropic_api_key' });
      return NextResponse.json({ source: 'anthropic_api_key', key: auth.headers['x-api-key'] }, { headers: NO_STORE });
    }
    return fail(404, 'No agent model endpoint for this task');
  } catch {
    // The error could carry decrypted material; log nothing of it.
    console.error(`[model-endpoint] resolution failed for task ${taskId}`);
    return fail(500, 'Could not resolve the model endpoint');
  }
}
