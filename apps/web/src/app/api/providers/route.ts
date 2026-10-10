import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import {
  NO_PERSON_KEY,
  NO_PERSON_TASK_TOKEN,
  TASK_TOKEN_READ_ONLY,
  resolveProvidersCaller,
  type ProvidersCaller,
} from '@/lib/providers/caller';
import {
  deleteProviderCredential,
  countPersonalKeys,
  listProviders,
  loadPolicySummary,
  planProviderWrite,
  setCredentialPolicy,
  setProviderCredential,
} from '@/lib/providers/credentials';
import { isCredentialPolicy } from '@buildd/core/providers';
import {
  POLICY_PERMISSION,
  isProviderApiScope,
  isProviderId,
  isShapeId,
  isSurface,
  type ProviderApiScope,
} from '@buildd/core/providers/manage';
import type { ListProvidersResponse, ProviderCredentialWriteResponse } from '@buildd/shared';

/**
 * Model providers: every registry provider, what it serves, the credentials
 * set at each scope, and the team's credential policy. The one place model
 * credentials are written (`@/lib/providers/write-path`).
 *
 *   GET    ?teamId=&workspaceId=                         → ListProvidersResponse
 *   PUT    { provider, shape?, scope, workspaceId?, value?, config?, surface?, teamId? }
 *                                                        → ProviderCredentialWriteResponse
 *   DELETE ?provider=&scope=&shape=&workspaceId=&teamId= → ProviderCredentialWriteResponse (deleted)
 *   PATCH  { credentialPolicy, teamId? }                 → { policy }
 *
 * Scopes: `team`, `workspace` (with workspaceId), `mine` (the caller's own).
 *
 * Who may do what:
 * - list: any member, any key of the team, a task token for its own
 *   workspace. `set.mine` is the caller's own rows (null for a key or token).
 * - set/delete at team or workspace scope: the permission of the storage
 *   written (`@buildd/core/providers/manage` writePermission:
 *   manage_team_model_keys for chat-key storage, manage_team_credentials for
 *   agent credentials, manage_inference_providers for a gateway or endpoint).
 * - set/delete `mine`: a signed-in person (dashboard or OAuth MCP), only
 *   where the registry offers a personal scope and the team policy accepts
 *   personal keys. A key or task token is refused with a reason.
 * - PATCH policy: manage_team_settings (as PATCH /api/teams/[id]).
 *
 * 422 `provider_surface_unsupported` / `provider_scope_unsupported` carry the
 * registry's reason verbatim. No response carries a credential value: rows are
 * summarised by last four characters and health.
 */

function teamParam(req: NextRequest): string | null {
  return req.nextUrl.searchParams.get('teamId');
}

function personRequired(caller: ProvidersCaller): Response | null {
  if (caller.principal === 'task_token') return NextResponse.json({ error: NO_PERSON_TASK_TOKEN }, { status: 403 });
  if (caller.principal === 'key') return NextResponse.json({ error: NO_PERSON_KEY }, { status: 403 });
  return null;
}

async function authorizeWrite(caller: ProvidersCaller, scope: ProviderApiScope, permissions: readonly string[]): Promise<Response | null> {
  if (caller.principal === 'task_token') return NextResponse.json({ error: TASK_TOKEN_READ_ONLY }, { status: 403 });
  if (scope === 'mine') return personRequired(caller);
  for (const p of permissions) {
    if (!(await caller.may(p as never))) {
      return NextResponse.json({ error: `Only a team owner or admin can change the team's model credentials (needs ${p}).` }, { status: 403 });
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const r = await resolveProvidersCaller(req, teamParam(req), t => authenticateTaskScopedCaller(t, req));
  if (!r.ok) return r.response;
  const caller = r.caller;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId') || (caller.taskScope?.workspaceId ?? null);
  if (!taskScopeAllowsWorkspace(caller, workspaceId)) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  try {
    const [providers, policy, keys, creds, inference, settings, personalKeyCount] = await Promise.all([
      listProviders({ teamId: caller.teamId, workspaceId, userId: caller.userId }),
      loadPolicySummary(caller.teamId),
      caller.may('manage_team_model_keys'),
      caller.may('manage_team_credentials'),
      caller.may('manage_inference_providers'),
      caller.may(POLICY_PERMISSION),
      countPersonalKeys(caller.teamId),
    ]);
    const body: ListProvidersResponse = {
      teamId: caller.teamId,
      workspaceId,
      caller: {
        principal: caller.principal,
        can: { manage_team_model_keys: keys, manage_team_credentials: creds, manage_inference_providers: inference, manage_team_settings: settings },
        canSetMine: caller.principal === 'person',
      },
      policy,
      personalKeyCount,
      providers,
    };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[providers] list failed:', error);
    return NextResponse.json({ error: 'Failed to list providers' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const r = await resolveProvidersCaller(req, typeof body.teamId === 'string' ? body.teamId : null, t => authenticateTaskScopedCaller(t, req));
  if (!r.ok) return r.response;
  const caller = r.caller;
  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : null;
  if (!taskScopeAllowsWorkspace(caller, workspaceId ?? '')) return NextResponse.json({ error: TASK_TOKEN_READ_ONLY }, { status: 403 });

  if (!isProviderId(body.provider)) return NextResponse.json({ error: 'provider must be a registry provider id' }, { status: 400 });
  if (!isProviderApiScope(body.scope)) return NextResponse.json({ error: "scope must be 'team', 'workspace' or 'mine'" }, { status: 400 });
  if (body.shape !== undefined && !isShapeId(body.shape)) return NextResponse.json({ error: 'shape is not a credential shape' }, { status: 400 });
  if (body.surface !== undefined && !isSurface(body.surface)) return NextResponse.json({ error: 'surface must be chat, agent-claude, agent-codex or cloud-egress' }, { status: 400 });
  const config = body.config === undefined ? undefined : body.config;
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) {
    return NextResponse.json({ error: 'config must be an object' }, { status: 400 });
  }

  const planned = planProviderWrite({ provider: body.provider, shape: body.shape as never, scope: body.scope, surface: body.surface as never, op: 'set' });
  if (!planned.ok) return NextResponse.json(planned.refusal.body, { status: planned.refusal.status });
  const denied = await authorizeWrite(caller, body.scope, planned.plan.permissions);
  if (denied) return denied;

  try {
    const result = await setProviderCredential({
      plan: planned.plan, teamId: caller.teamId, workspaceId, userId: caller.userId,
      value: body.value, config: config as Record<string, unknown> | undefined,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    const out: ProviderCredentialWriteResponse = {
      provider: body.provider, scope: body.scope, workspaceId: body.scope === 'workspace' ? workspaceId : null,
      credentials: result.credentials,
      ...(result.requeued !== undefined ? { requeued: result.requeued } : {}),
    };
    return NextResponse.json(out);
  } catch (error) {
    console.error('[providers] set failed:', error);
    return NextResponse.json({ error: 'Failed to save the credential' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const r = await resolveProvidersCaller(req, teamParam(req), t => authenticateTaskScopedCaller(t, req));
  if (!r.ok) return r.response;
  const caller = r.caller;
  const workspaceId = params.get('workspaceId') || null;
  if (!taskScopeAllowsWorkspace(caller, workspaceId ?? '')) return NextResponse.json({ error: TASK_TOKEN_READ_ONLY }, { status: 403 });

  const provider = params.get('provider');
  const scope = params.get('scope');
  const shape = params.get('shape') ?? undefined;
  if (!isProviderId(provider)) return NextResponse.json({ error: 'provider must be a registry provider id' }, { status: 400 });
  if (!isProviderApiScope(scope)) return NextResponse.json({ error: "scope must be 'team', 'workspace' or 'mine'" }, { status: 400 });
  if (shape !== undefined && !isShapeId(shape)) return NextResponse.json({ error: 'shape is not a credential shape' }, { status: 400 });

  const planned = planProviderWrite({ provider, shape, scope, op: 'delete' });
  if (!planned.ok) return NextResponse.json(planned.refusal.body, { status: planned.refusal.status });
  const denied = await authorizeWrite(caller, scope, planned.plan.permissions);
  if (denied) return denied;

  try {
    const result = await deleteProviderCredential({ plan: planned.plan, teamId: caller.teamId, workspaceId, userId: caller.userId });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    const out: ProviderCredentialWriteResponse = {
      provider, scope, workspaceId: scope === 'workspace' ? workspaceId : null, credentials: result.credentials, deleted: result.deleted,
    };
    return NextResponse.json(out);
  } catch (error) {
    console.error('[providers] delete failed:', error);
    return NextResponse.json({ error: 'Failed to remove the credential' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const r = await resolveProvidersCaller(req, typeof body.teamId === 'string' ? body.teamId : null, t => authenticateTaskScopedCaller(t, req));
  if (!r.ok) return r.response;
  const caller = r.caller;
  if (caller.taskScope) return NextResponse.json({ error: TASK_TOKEN_READ_ONLY }, { status: 403 });
  if (!isCredentialPolicy(body.credentialPolicy)) {
    return NextResponse.json({ error: 'credentialPolicy must be "team", "personal_first" or "personal_only"' }, { status: 400 });
  }
  if (!(await caller.may(POLICY_PERMISSION))) {
    return NextResponse.json({ error: `Only a team owner or admin can change the credential policy (needs ${POLICY_PERMISSION}).` }, { status: 403 });
  }
  try {
    return NextResponse.json({ policy: await setCredentialPolicy(caller.teamId, body.credentialPolicy) });
  } catch (error) {
    console.error('[providers] policy write failed:', error);
    return NextResponse.json({ error: 'Failed to change the credential policy' }, { status: 500 });
  }
}
