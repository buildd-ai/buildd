import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { modelTierRegistry, workspaces } from '@buildd/core/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import {
  getUserTeamIds,
  getUserTeamRole,
  resolveActiveTeamId,
  verifyWorkspaceAccess,
  verifyAccountWorkspaceAccess,
} from '@/lib/team-access';
import { resolveAllTiers, invalidateTierCache, TIERS, type Tier } from '@buildd/core/model-tier-registry';

// Resolve the teamId for a given workspaceId.
async function getTeamIdForWorkspace(workspaceId: string): Promise<string | null> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  return ws?.teamId ?? null;
}

const ADMIN_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

type TeamResolution = { teamId: string } | { error: NextResponse };

/**
 * Resolve which team's registry a request reads or writes, and check the caller
 * may do so.
 *
 * - `workspaceId`: the caller must reach that workspace. Without this check any
 *   session user (or any admin key on another team) could read or overwrite
 *   another team's tier registry, which the claim path then honours. Denied or
 *   missing workspaces 404, like the other workspace routes.
 * - `teamId` (session only): the caller must belong to that team. Settings →
 *   Model tiers sends it, so a user in several teams edits the team on screen.
 * - neither: an API key's own team, or the session's ACTIVE team (the
 *   `buildd-team` cookie), not whichever membership row happens to come first.
 *
 * Session writes also need owner or admin in the resolved team: which model
 * backs a tier sets spend for the whole team, so it is an admin call
 * (docs/design/agent-chat.md → Models). API keys are already held to admin level
 * by each handler.
 */
async function resolveTeam(
  req: NextRequest,
  user: { id: string } | null,
  apiAccount: { id: string; teamId?: string | null } | null,
  opts: { workspaceId: string | null; teamId: string | null; write: boolean },
): Promise<TeamResolution> {
  const fail = (status: number, error: string) => ({ error: NextResponse.json({ error }, { status }) });

  if (apiAccount) {
    if (opts.workspaceId) {
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount.id, opts.workspaceId);
      if (!hasAccess) return fail(404, 'Workspace not found');
      const teamId = await getTeamIdForWorkspace(opts.workspaceId);
      return teamId ? { teamId } : fail(404, 'Workspace not found');
    }
    return apiAccount.teamId ? { teamId: apiAccount.teamId } : fail(400, 'Could not resolve team');
  }

  if (!user) return fail(401, 'Unauthorized');

  let teamId: string | null;
  let role: string | null = null;
  if (opts.workspaceId) {
    const access = await verifyWorkspaceAccess(user.id, opts.workspaceId);
    if (!access?.teamId) return fail(404, 'Workspace not found');
    teamId = access.teamId;
    role = (access as { role?: string | null }).role ?? null;
  } else if (opts.teamId) {
    const teamIds = await getUserTeamIds(user.id);
    if (!teamIds.includes(opts.teamId)) return fail(404, 'Team not found');
    teamId = opts.teamId;
  } else {
    teamId = await resolveActiveTeamId(user.id, req.cookies.get('buildd-team')?.value);
  }
  if (!teamId) return fail(400, 'Could not resolve team');

  if (opts.write) {
    if (!role) role = await getUserTeamRole(user.id, teamId);
    if (!role || !ADMIN_ROLES.has(role)) {
      return fail(403, 'Only a team owner or admin can change model tiers');
    }
  }
  return { teamId };
}

/** Session user or API key, with API keys held to admin level. */
async function authenticate(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return { error: NextResponse.json({ error: 'Admin token required' }, { status: 403 }) };
  }
  return { user, apiAccount: apiAccount as { id: string; teamId?: string | null } | null };
}

// GET /api/model-tiers?workspaceId=<id> | ?teamId=<id>
// Returns the effective tier map (workspace override → team default → catalog → code fallback).
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;

  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId') || null;

  try {
    const resolved = await resolveTeam(req, auth.user, auth.apiAccount, {
      workspaceId,
      teamId: searchParams.get('teamId') || null,
      write: false,
    });
    if ('error' in resolved) return resolved.error;

    const tiers = await resolveAllTiers(resolved.teamId, workspaceId);
    return NextResponse.json(tiers);
  } catch (error) {
    console.error('GET /api/model-tiers error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/model-tiers — upsert a registry row (pins the tier)
// Body: { tier, provider, model, workspaceId?, teamId?, defaultEffort?, defaultMaxTurns? }
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;

  try {
    const body = await req.json();
    const { tier, provider, model, workspaceId, defaultEffort, defaultMaxTurns } = body;

    if (!tier || !TIERS.includes(tier as Tier)) {
      return NextResponse.json({ error: `tier must be one of ${TIERS.join(', ')}` }, { status: 400 });
    }
    if (!provider || !['anthropic', 'openai', 'openai-codex', 'openrouter'].includes(provider)) {
      return NextResponse.json({ error: 'provider must be anthropic, openai, openai-codex, or openrouter' }, { status: 400 });
    }
    if (!model || typeof model !== 'string') {
      return NextResponse.json({ error: 'model is required' }, { status: 400 });
    }

    const resolved = await resolveTeam(req, auth.user, auth.apiAccount, {
      workspaceId: workspaceId ?? null,
      teamId: typeof body.teamId === 'string' ? body.teamId : null,
      write: true,
    });
    if ('error' in resolved) return resolved.error;
    const { teamId } = resolved;

    const now = new Date();
    // Manual upsert to handle NULL workspace_id uniqueness correctly.
    // First check if a row already exists.
    const existing = await db.query.modelTierRegistry.findFirst({
      where: and(
        eq(modelTierRegistry.teamId, teamId),
        eq(modelTierRegistry.tier, tier as Tier),
        workspaceId
          ? eq(modelTierRegistry.workspaceId, workspaceId)
          : isNull(modelTierRegistry.workspaceId),
      ),
    });

    if (existing) {
      await db
        .update(modelTierRegistry)
        .set({
          provider,
          model,
          defaultEffort: defaultEffort ?? null,
          defaultMaxTurns: typeof defaultMaxTurns === 'number' ? defaultMaxTurns : null,
          updatedAt: now,
        })
        .where(eq(modelTierRegistry.id, existing.id));
    } else {
      await db.insert(modelTierRegistry).values({
        teamId,
        workspaceId: workspaceId ?? null,
        tier: tier as Tier,
        provider,
        model,
        defaultEffort: defaultEffort ?? null,
        defaultMaxTurns: typeof defaultMaxTurns === 'number' ? defaultMaxTurns : null,
        createdAt: now,
        updatedAt: now,
      });
    }

    invalidateTierCache(teamId, workspaceId ?? null);

    return NextResponse.json({ ok: true, tier, provider, model });
  } catch (error) {
    console.error('POST /api/model-tiers error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/model-tiers?tier=<tier>&workspaceId=<id> | &teamId=<id>
// Removes a registry row (unpins), falling back to the next level in the chain.
export async function DELETE(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;

  const { searchParams } = new URL(req.url);
  const tier = searchParams.get('tier');
  const workspaceId = searchParams.get('workspaceId') || null;

  if (!tier || !TIERS.includes(tier as Tier)) {
    return NextResponse.json({ error: `tier must be one of ${TIERS.join(', ')}` }, { status: 400 });
  }

  try {
    const resolved = await resolveTeam(req, auth.user, auth.apiAccount, {
      workspaceId,
      teamId: searchParams.get('teamId') || null,
      write: true,
    });
    if ('error' in resolved) return resolved.error;
    const { teamId } = resolved;

    await db
      .delete(modelTierRegistry)
      .where(and(
        eq(modelTierRegistry.teamId, teamId),
        eq(modelTierRegistry.tier, tier as Tier),
        workspaceId
          ? eq(modelTierRegistry.workspaceId, workspaceId)
          : isNull(modelTierRegistry.workspaceId),
      ));

    invalidateTierCache(teamId, workspaceId ?? null);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('DELETE /api/model-tiers error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
