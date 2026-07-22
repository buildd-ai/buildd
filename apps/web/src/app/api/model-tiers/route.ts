import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { modelTierRegistry, workspaces } from '@buildd/core/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { resolveAllTiers, invalidateTierCache, type Tier } from '@buildd/core/model-tier-registry';

// Resolve the teamId for a given workspaceId.
async function getTeamIdForWorkspace(workspaceId: string): Promise<string | null> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  return ws?.teamId ?? null;
}

// GET /api/model-tiers?workspaceId=<id>
// Returns the effective tier map (workspace override → team default → code fallback).
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspaceId') || null;

  try {
    let teamId: string | null = null;

    if (apiAccount) {
      teamId = (apiAccount as any).teamId as string | null;
    } else if (user) {
      const teamIds = await getUserTeamIds(user.id);
      teamId = teamIds[0] ?? null;
    }

    if (workspaceId) {
      const wsTeamId = await getTeamIdForWorkspace(workspaceId);
      if (wsTeamId) teamId = wsTeamId;
    }

    if (!teamId) {
      return NextResponse.json({ error: 'Could not resolve team' }, { status: 400 });
    }

    const tiers = await resolveAllTiers(teamId, workspaceId);
    return NextResponse.json(tiers);
  } catch (error) {
    console.error('GET /api/model-tiers error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/model-tiers — upsert a registry row
// Body: { tier, provider, model, workspaceId?, defaultEffort?, defaultMaxTurns? }
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { tier, provider, model, workspaceId, defaultEffort, defaultMaxTurns } = body;

    if (!tier || !['premium', 'standard', 'budget'].includes(tier)) {
      return NextResponse.json({ error: 'tier must be premium, standard, or budget' }, { status: 400 });
    }
    if (!provider || !['anthropic', 'openai-codex', 'openrouter'].includes(provider)) {
      return NextResponse.json({ error: 'provider must be anthropic, openai-codex, or openrouter' }, { status: 400 });
    }
    if (!model || typeof model !== 'string') {
      return NextResponse.json({ error: 'model is required' }, { status: 400 });
    }

    let teamId: string | null = null;
    if (apiAccount) {
      teamId = (apiAccount as any).teamId as string | null;
    } else if (user) {
      const teamIds = await getUserTeamIds(user.id);
      teamId = teamIds[0] ?? null;
    }
    if (workspaceId) {
      const wsTeamId = await getTeamIdForWorkspace(workspaceId);
      if (wsTeamId) teamId = wsTeamId;
    }
    if (!teamId) {
      return NextResponse.json({ error: 'Could not resolve team' }, { status: 400 });
    }

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

// DELETE /api/model-tiers?tier=<tier>&workspaceId=<id>
// Removes a registry row, falling back to the next level in the chain.
export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const tier = searchParams.get('tier');
  const workspaceId = searchParams.get('workspaceId') || null;

  if (!tier || !['premium', 'standard', 'budget'].includes(tier)) {
    return NextResponse.json({ error: 'tier must be premium, standard, or budget' }, { status: 400 });
  }

  try {
    let teamId: string | null = null;
    if (apiAccount) {
      teamId = (apiAccount as any).teamId as string | null;
    } else if (user) {
      const teamIds = await getUserTeamIds(user.id);
      teamId = teamIds[0] ?? null;
    }
    if (workspaceId) {
      const wsTeamId = await getTeamIdForWorkspace(workspaceId);
      if (wsTeamId) teamId = wsTeamId;
    }
    if (!teamId) {
      return NextResponse.json({ error: 'Could not resolve team' }, { status: 400 });
    }

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
