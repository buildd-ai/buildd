import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { modelTierRegistry } from '@buildd/core/db/schema';
import { resolveAllTiers, resolveTierEntry, invalidateTierCache, type Tier } from '@buildd/core/model-tier-registry';
import { resolveInferenceCredential, isInferenceKeyProvider } from '@buildd/core/inference-keys';
import { POOL_SURFACES, incumbentRoute, isArmRoute, tierAllowsPool, type PoolSurface } from '@buildd/core/tier-pool';
import { addChallenger, ensurePool, listTeamPools, loadArmStats } from '@buildd/core/tier-pool-admin';
import { invalidateTierPoolCache } from '@buildd/core/tier-pool-source';
import { getCachedOpenRouterCatalog } from '@buildd/core/model-catalog-cache';
import { priceFromCatalog } from '@buildd/core/model-catalog';
import { isWeightLevel, suggestWeight, type WeightLevel } from '@buildd/core/tier-weights';
import { tierPoolAccess } from '@/lib/tier-pool-access';
import { buildTierPoolRows, type TierPoolsResponse } from '@/lib/tier-pools-view';

/**
 * GET /api/model-tiers/pools?teamId= — every tier's arms, traffic and stats,
 * per surface (docs/design/tier-model-pools.md §9). Members read.
 */
export async function GET(req: NextRequest) {
  const access = await tierPoolAccess(new URL(req.url).searchParams.get('teamId'), false);
  if (!access.ok) return access.response;
  try {
    const [agent, chat, pools, stats] = await Promise.all([
      resolveAllTiers(access.teamId, null, 'agent'),
      resolveAllTiers(access.teamId, null, 'chat'),
      listTeamPools(access.teamId),
      loadArmStats(access.teamId),
    ]);
    const tiers = { agent, chat };
    const body: TierPoolsResponse = { rows: buildTierPoolRows({ tiers, pools, stats }), isAdmin: access.isAdmin };
    return NextResponse.json(body);
  } catch (err) {
    console.error('GET /api/model-tiers/pools error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

/**
 * POST /api/model-tiers/pools — add a challenger arm to a tier's pool.
 * Body: { teamId, tier, surface, route, model, weight? }. The pool is created
 * on first use; the incumbent (the registry row) is pinned first if the tier
 * was following the catalog, so the baseline cannot move mid-comparison. The
 * new arm starts at a weight — the caller's, or a price-based suggestion
 * (docs/design/tier-weights.md §2) — and carries traffic immediately.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const access = await tierPoolAccess(body.teamId, true);
  if (!access.ok) return access.response;

  const { tier, surface, route, model, weight } = body as { tier?: string; surface?: string; route?: string; model?: string; weight?: string };
  if (!tier || !tierAllowsPool(tier)) {
    return NextResponse.json({ error: 'tier must be premium, standard or budget (premium-plus stays pinned)' }, { status: 400 });
  }
  if (!surface || !(POOL_SURFACES as readonly string[]).includes(surface)) {
    return NextResponse.json({ error: 'surface must be agent or chat' }, { status: 400 });
  }
  const s = surface as PoolSurface;
  if (!isArmRoute(s, route)) {
    return NextResponse.json({ error: s === 'agent' ? 'route must be runner:claude or runner:codex' : 'route must be anthropic, openai or openrouter' }, { status: 400 });
  }
  if (typeof model !== 'string' || !MODEL_RE.test(model.trim())) {
    return NextResponse.json({ error: 'model must be a model id' }, { status: 400 });
  }
  if (weight !== undefined && !isWeightLevel(weight)) {
    return NextResponse.json({ error: 'weight must be off, low, med or high' }, { status: 400 });
  }
  const modelId = model.trim();

  try {
    // Chat arms only on a route whose key resolves for this admin or the team.
    if (s === 'chat' && isInferenceKeyProvider(route)) {
      const cred = await resolveInferenceCredential({ provider: route, teamId: access.teamId, workspaceId: null, userId: access.userId });
      if (!cred) return NextResponse.json({ error: `No ${route} key is connected for this team`, code: 'no_key' }, { status: 400 });
    }

    // The surface's own row when the tier is split, else the shared row.
    const entry = await resolveTierEntry(tier as Tier, access.teamId, null, s);
    const baseRoute = incumbentRoute(s, entry.provider);
    if (baseRoute === route && entry.model === modelId) {
      return NextResponse.json({ error: 'That is already the base model', code: 'duplicate' }, { status: 409 });
    }
    if (entry.source !== 'team' && entry.source !== 'workspace') {
      await pinIncumbent(access.teamId, tier as Tier, entry.provider, entry.model);
    }

    const catalog = await getCachedOpenRouterCatalog();
    const suggested = suggestWeight(priceFromCatalog(catalog, modelId), priceFromCatalog(catalog, entry.model));

    const { pool } = await ensurePool({
      teamId: access.teamId, tier, surface: s,
      incumbent: { route: baseRoute, model: entry.model }, actorUserId: access.userId,
    });
    const chosenWeight = (weight as WeightLevel | undefined) ?? suggested;
    const added = await addChallenger({
      teamId: access.teamId, poolId: pool.id, route, model: modelId, weight: chosenWeight, actorUserId: access.userId,
      evidence: { suggestedWeight: suggested, chosenWeight, priceSource: 'openrouter-catalog' },
    });
    invalidateTierPoolCache(access.teamId);
    if (!added.ok) {
      return added.reason === 'full'
        ? NextResponse.json({ error: 'A tier holds at most 4 models', code: 'full' }, { status: 409 })
        : NextResponse.json({ error: 'That model is already in this tier', code: 'duplicate' }, { status: 409 });
    }
    return NextResponse.json({ ok: true, poolId: pool.id, armId: added.armId, suggestedWeight: suggested }, { status: 201 });
  } catch (err) {
    console.error('POST /api/model-tiers/pools error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Write the resolved catalog/default pick as the team's shared registry row.
 * Only reached when neither the surface's row nor the shared row exists.
 */
async function pinIncumbent(teamId: string, tier: Tier, provider: string, model: string): Promise<void> {
  const existing = await db.query.modelTierRegistry.findFirst({
    where: and(
      eq(modelTierRegistry.teamId, teamId), eq(modelTierRegistry.tier, tier),
      isNull(modelTierRegistry.workspaceId), isNull(modelTierRegistry.surface),
    ),
    columns: { id: true },
  });
  if (!existing) {
    await db.insert(modelTierRegistry).values({
      teamId, workspaceId: null, tier, provider: provider as typeof modelTierRegistry.$inferInsert['provider'], model,
    });
  }
  invalidateTierCache(teamId, null);
}
