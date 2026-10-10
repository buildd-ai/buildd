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
 * ## Credential policy (provider parity, slice 6)
 *
 * A team with `credential_policy` NULL gets exactly the decision above: the
 * legacy path runs unchanged (`resolveAgentModelRoute`, then
 * `resolveAnthropicAuth`). That is the per-team opt-in; there is no flag.
 *
 * Once a team sets `credential_policy`, the route asks the one resolver
 * instead: `resolveProviderCredential` with `surface: 'cloud-egress'` and the
 * task's requester (`resolveTaskRequesterUserId`), so the policy and the
 * requester rule decide which scopes are eligible (a personal key serves only
 * its owner's task; `personal_only` with no requester resolves nothing).
 * Seats are impossible on this surface (registry reason), so they never win.
 * The winner becomes the wire answer:
 *   - an Anthropic API key, canonical (`inference_key`/anthropic) or legacy
 *     (`anthropic_api_key`) ⇒ `{ source: 'anthropic_api_key', key }`, so the
 *     dispatcher still ranks it ahead of `MODEL_PROXY_URL`;
 *   - an `agent_endpoint` ⇒ the endpoint. A reference (a gateway, or an
 *     `openrouter` row with no inline key) resolves what it points at, the
 *     gateway or the stored OpenRouter key, at the same scope or broader, as
 *     `resolveAgentEndpoint` does;
 *   - an OpenRouter key ⇒ an `openrouter` endpoint on OpenRouter's
 *     Anthropic-compatible root;
 *   - nothing ⇒ 404 with `reason` (`no_credential` | `no_personal_credential`).
 *
 * Design: docs/design/agent-model-endpoint.md §3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, teams } from '@buildd/core/db/schema';
import {
  OPENROUTER_AGENT_BASE_URL,
  isEndpointReference,
  resolveAgentEndpoint,
  resolveAgentModelRoute,
  resolveEndpointFromBlob,
  type AgentEndpointRoute,
} from '@buildd/core/agent-endpoint';
import { surfacePolicy, type TeamPolicyColumns } from '@buildd/core/providers';
import { resolveProviderCredential, type ProviderCredentialResult } from '@buildd/core/providers/resolve';
import { resolveTaskRequesterUserId } from '@buildd/core/task-requester';
import { isAnthropicApiKeyAuth, resolveAnthropicAuth } from '@/lib/claude-credential';
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
    const team = await loadTeamPolicy(ws.teamId);
    if (surfacePolicy(team, 'cloud-egress').enforced) {
      const requesterUserId = await loadRequester(task.id);
      const result = await resolveProviderCredential({
        teamId: ws.teamId,
        workspaceId: ws.id,
        accountId: account.id,
        requesterUserId,
        surface: 'cloud-egress',
        team,
      });
      const answer = await wireAnswer(result, ws);
      if (!answer.ok) {
        void recordCapabilityDecision({ ...audit, decision: 'refused', resource: 'model', reasonCode: answer.reason });
        return NextResponse.json(
          { error: 'No agent model endpoint for this task', reason: answer.reason },
          { status: 404, headers: NO_STORE },
        );
      }
      void recordCapabilityDecision({ ...audit, decision: 'allowed', resource: answer.resource });
      return NextResponse.json(answer.body, { headers: NO_STORE });
    }

    // credential_policy NULL: exactly the decision this route always made.
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
    if (auth && isAnthropicApiKeyAuth(auth)) {
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

// ── Policy path ──────────────────────────────────────────────────────────────

/** The team's policy columns. Unreadable reads as unset, i.e. the legacy path. */
async function loadTeamPolicy(teamId: string): Promise<TeamPolicyColumns | null> {
  try {
    return (await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { credentialPolicy: true, inferenceKeyPolicy: true },
    })) ?? null;
  } catch {
    console.warn('[model-endpoint] team policy lookup failed; using the legacy path');
    return null;
  }
}

/** Who the task is for. A failed walk reads as team work, never as someone's. */
async function loadRequester(taskId: string): Promise<string | null> {
  try {
    const row = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { createdByUserId: true, parentTaskId: true, missionId: true, scheduleId: true },
    });
    return row ? await resolveTaskRequesterUserId(row) : null;
  } catch {
    console.warn(`[model-endpoint] requester lookup failed for task ${taskId}; treating it as team work`);
    return null;
  }
}

type WireAnswer =
  | { ok: true; body: Record<string, unknown>; resource: string }
  | { ok: false; reason: string };

function endpointBody(route: AgentEndpointRoute) {
  return {
    kind: route.kind, baseUrl: route.baseUrl, key: route.apiKey, authHeader: route.authHeader, models: route.models,
    // `cloudflare`: which provider its gateway forwards to (model naming), and
    // the gateway's own header. The egress handler adds both to each call.
    ...(route.upstream ? { upstream: route.upstream } : {}),
    ...(route.headers ? { headers: route.headers } : {}),
  };
}

/** The resolver's winner as the dispatcher's egress handler reads it. */
async function wireAnswer(result: ProviderCredentialResult, ws: { id: string; teamId: string }): Promise<WireAnswer> {
  if (result.none) return { ok: false, reason: result.reason };
  const { credential } = result;
  if (credential.provider === 'anthropic' && credential.shape === 'api_key') {
    // Canonical or legacy storage alike: the team's (or requester's) own
    // metered key, so it keeps its precedence over MODEL_PROXY_URL.
    return { ok: true, body: { source: 'anthropic_api_key', key: credential.value }, resource: 'anthropic_api_key' };
  }
  if (credential.endpoint) {
    const blob = credential.endpoint;
    if (isEndpointReference(blob)) {
      // A reference needs what it points at, at the same scope or broader: a
      // gateway reference its gateway, an OpenRouter reference the stored
      // OpenRouter key. resolveAgentEndpoint owns that lookup (the gateway
      // module is not ours to import, scripts/module-boundaries.test.ts); it
      // ranks endpoint rows exactly as the resolver does, so it lands on the
      // same row. If it ever does not, nothing is served rather than a
      // different endpoint.
      const resolved = await resolveAgentEndpoint({ teamId: ws.teamId, workspaceId: ws.id });
      if (!resolved || resolved.secretId !== result.source.secretId) return { ok: false, reason: 'no_credential' };
      return { ok: true, body: endpointBody(resolved), resource: `agent_endpoint:${resolved.kind}` };
    }
    const route = resolveEndpointFromBlob(blob, null);
    if (!route) return { ok: false, reason: 'no_credential' };
    return { ok: true, body: endpointBody(route), resource: `agent_endpoint:${route.kind}` };
  }
  if (credential.provider === 'openrouter' && credential.shape === 'api_key') {
    const route = resolveEndpointFromBlob(
      { kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, apiKey: credential.value, authHeader: 'authorization' },
      null,
    );
    return route ? { ok: true, body: endpointBody(route), resource: 'openrouter' } : { ok: false, reason: 'no_credential' };
  }
  // Nothing else is servable on cloud egress (the registry rules seats out).
  return { ok: false, reason: 'no_credential' };
}
