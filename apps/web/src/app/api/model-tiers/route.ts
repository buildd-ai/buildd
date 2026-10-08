import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { modelTierRegistry } from '@buildd/core/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { authenticate, resolveTeam } from '@/lib/model-tier-access';
import { resolveAllTiers, invalidateTierCache, TIERS, type Tier, type TierSurface } from '@buildd/core/model-tier-registry';
import { isTierSurface, type TierEntryWithSurfaces } from '@buildd/core/model-tier-defaults';

/** `surface` from a body or query: absent/null = the shared row; anything else must name a surface. */
function parseSurface(raw: unknown): { surface: TierSurface | null } | { error: NextResponse } {
  if (raw == null || raw === '') return { surface: null };
  if (isTierSurface(raw)) return { surface: raw };
  return { error: NextResponse.json({ error: 'surface must be agent or chat' }, { status: 400 }) };
}

function surfaceMatch(surface: TierSurface | null) {
  return surface ? eq(modelTierRegistry.surface, surface) : isNull(modelTierRegistry.surface);
}

// GET /api/model-tiers?workspaceId=<id> | ?teamId=<id>
// Returns the effective tier map (workspace override → team default → catalog → code fallback)
// for the shared rows, with each surface's resolution under `bySurface`.
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

    const [shared, agent, chat] = await Promise.all([
      resolveAllTiers(resolved.teamId, workspaceId, null),
      resolveAllTiers(resolved.teamId, workspaceId, 'agent'),
      resolveAllTiers(resolved.teamId, workspaceId, 'chat'),
    ]);
    const body = Object.fromEntries(TIERS.map((tier) => [
      tier,
      { ...shared[tier], bySurface: { agent: agent[tier], chat: chat[tier] } },
    ])) as Record<Tier, TierEntryWithSurfaces>;
    return NextResponse.json(body);
  } catch (error) {
    console.error('GET /api/model-tiers error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/model-tiers — upsert a registry row (pins the tier)
// Body: { tier, provider, model, surface?, workspaceId?, teamId?, defaultEffort?, defaultMaxTurns? }
// surface absent = the row serves both surfaces.
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
    const parsed = parseSurface(body.surface);
    if ('error' in parsed) return parsed.error;
    const { surface } = parsed;

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
        surfaceMatch(surface),
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
        surface,
        defaultEffort: defaultEffort ?? null,
        defaultMaxTurns: typeof defaultMaxTurns === 'number' ? defaultMaxTurns : null,
        createdAt: now,
        updatedAt: now,
      });
    }

    invalidateTierCache(teamId, workspaceId ?? null);

    return NextResponse.json({ ok: true, tier, provider, model, surface });
  } catch (error) {
    console.error('POST /api/model-tiers error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/model-tiers?tier=<tier>&surface=<agent|chat>?&workspaceId=<id> | &teamId=<id>
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
  const parsed = parseSurface(searchParams.get('surface'));
  if ('error' in parsed) return parsed.error;

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
        surfaceMatch(parsed.surface),
      ));

    invalidateTierCache(teamId, workspaceId ?? null);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('DELETE /api/model-tiers error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
