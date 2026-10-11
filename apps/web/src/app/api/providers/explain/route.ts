import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { resolveProvidersCaller } from '@/lib/providers/caller';
import { resolveProviderCredential } from '@buildd/core/providers/resolve';
import { PROVIDER_SURFACE_UNSUPPORTED, isProviderId, isSurface, surfaceRefusal } from '@buildd/core/providers/manage';
import type { ExplainProviderResponse, ProviderRefusal } from '@buildd/shared';

/**
 * What the resolver would pick, and why, without running anything.
 *
 *   GET ?surface=&provider=&workspaceId=&as=self|team&teamId= → ExplainProviderResponse
 *
 * `surface` (required): chat | agent-claude | agent-codex | cloud-egress.
 * `provider`: narrow to one provider; one the surface cannot use is 422
 * `provider_surface_unsupported` with the registry's reason.
 * `as`: `self` (default for a signed-in person) resolves for work the caller
 * started, so their own credential counts when the policy allows it; `team`
 * (the only choice for a key or task token) resolves team work, with no
 * requester. A task token is confined to its own workspace.
 *
 * The answer names the winning row (scope, id, storage) and the ordered `why`
 * trail. Never a value.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const r = await resolveProvidersCaller(req, params.get('teamId'), t => authenticateTaskScopedCaller(t, req));
  if (!r.ok) return r.response;
  const caller = r.caller;

  const surface = params.get('surface');
  if (!isSurface(surface)) {
    return NextResponse.json({ error: 'surface must be chat, agent-claude, agent-codex or cloud-egress' }, { status: 400 });
  }
  const provider = params.get('provider');
  if (provider !== null && !isProviderId(provider)) return NextResponse.json({ error: 'provider must be a registry provider id' }, { status: 400 });
  if (provider) {
    const no = surfaceRefusal(provider, surface);
    if (no) {
      const body: ProviderRefusal = { error: PROVIDER_SURFACE_UNSUPPORTED, provider, surface, reason: no.reason, ...(no.instead ? { instead: no.instead } : {}) };
      return NextResponse.json(body, { status: 422 });
    }
  }
  const workspaceId = params.get('workspaceId') || (caller.taskScope?.workspaceId ?? null);
  if (!taskScopeAllowsWorkspace(caller, workspaceId)) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  const asParam = params.get('as');
  if (asParam !== null && asParam !== 'self' && asParam !== 'team') return NextResponse.json({ error: "as must be 'self' or 'team'" }, { status: 400 });
  if (asParam === 'self' && !caller.userId) {
    return NextResponse.json({ error: 'as=self needs a signed-in person; a key or task token can explain team work only (as=team).' }, { status: 403 });
  }
  const as: 'self' | 'team' = asParam === 'team' || !caller.userId ? 'team' : 'self';

  try {
    if (workspaceId) {
      const { db } = await import('@buildd/core/db');
      const { workspaces } = await import('@buildd/core/db/schema');
      const { and, eq } = await import('drizzle-orm');
      const ws = await db.query.workspaces.findFirst({ where: and(eq(workspaces.id, workspaceId), eq(workspaces.teamId, caller.teamId)), columns: { id: true } });
      if (!ws) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    const out = await resolveProviderCredential({
      teamId: caller.teamId,
      workspaceId,
      accountId: null,
      requesterUserId: as === 'self' ? caller.userId : null,
      surface,
      ...(provider ? { provider } : {}),
    });
    const body: ExplainProviderResponse = {
      surface,
      as,
      workspaceId,
      result: out.none
        ? { resolved: false, reason: out.reason }
        : { resolved: true, provider: out.provider, shape: out.credential.shape, scope: out.scope, source: out.source },
      why: out.why,
    };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[providers/explain] failed:', error);
    return NextResponse.json({ error: 'Failed to explain the credential choice' }, { status: 500 });
  }
}
