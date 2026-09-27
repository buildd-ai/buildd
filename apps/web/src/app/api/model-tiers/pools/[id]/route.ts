import { NextRequest, NextResponse } from 'next/server';
import { validateAllocation, type PoolArmRef } from '@buildd/core/tier-pool';
import { listPoolChanges, loadPool, writeAllocation } from '@buildd/core/tier-pool-admin';
import { enterExploreAllocation } from '@buildd/core/tier-explore';
import { loadPoolEvidence } from '@buildd/core/tier-pool-daily-source';
import { invalidateTierPoolCache, orderArms } from '@buildd/core/tier-pool-source';
import { backfillWeights, isWeightLevel, sharesFromWeights, type Weights } from '@buildd/core/tier-weights';
import { tierPoolAccess } from '@/lib/tier-pool-access';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/model-tiers/pools/[id]?teamId= — the pool's change log, newest first. Members read. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const access = await tierPoolAccess(new URL(req.url).searchParams.get('teamId'), false);
  if (!access.ok) return access.response;
  const changes = await listPoolChanges(access.teamId, id, 20);
  return NextResponse.json({
    changes: changes.map(c => ({
      id: c.id, kind: c.kind, before: c.before, after: c.after,
      actor: c.actorSystem ?? (c.actorUserId ? 'admin' : null), at: new Date(c.createdAt).toISOString(),
    })),
  });
}

/**
 * PATCH /api/model-tiers/pools/[id] — set weights, or pin/unpin/explore.
 * Body: { teamId, expectedVersion, weights?: {armId: 'off'|'low'|'med'|'high'}, mode?: 'pinned' | 'split' | 'explore' }.
 * The server derives the allocation from the weights in split mode
 * (docs/design/tier-weights.md §1) — an admin never sends a percentage.
 * Choosing explore hands the shares to buildd's daily step (tier-weights §3):
 * the current shares are projected onto each arm's stage bounds, and an
 * explore pool takes no typed weights.
 * Compare-and-set on the allocation version: a stale screen gets 409, never
 * a silent overwrite. Every accepted change writes an audit row.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const access = await tierPoolAccess(body.teamId, true);
  if (!access.ok) return access.response;

  const expectedVersion = body.expectedVersion;
  if (!Number.isInteger(expectedVersion)) return NextResponse.json({ error: 'expectedVersion is required' }, { status: 400 });
  const mode = body.mode;
  if (mode !== undefined && mode !== 'pinned' && mode !== 'split' && mode !== 'explore') {
    return NextResponse.json({ error: 'mode must be pinned, split or explore' }, { status: 400 });
  }
  if (mode === undefined && body.weights === undefined) {
    return NextResponse.json({ error: 'weights or mode is required' }, { status: 400 });
  }
  let weightsPatch: Weights | undefined;
  if (body.weights !== undefined) {
    if (!body.weights || typeof body.weights !== 'object' || Array.isArray(body.weights)) {
      return NextResponse.json({ error: 'weights must be an object of arm id to level' }, { status: 400 });
    }
    for (const [armId, level] of Object.entries(body.weights as Record<string, unknown>)) {
      if (!isWeightLevel(level)) return NextResponse.json({ error: `weight for arm ${armId} must be off, low, med or high` }, { status: 400 });
    }
    weightsPatch = body.weights as Weights;
  }

  try {
    const loaded = await loadPool(access.teamId, id);
    if (!loaded) return NextResponse.json({ error: 'Pool not found' }, { status: 404 });
    const { pool, arms } = loaded;

    const nextMode = mode ?? pool.mode;
    if (body.allocation !== undefined && nextMode === 'explore') {
      return NextResponse.json({ error: 'buildd sets the shares in explore' }, { status: 400 });
    }

    let allocation = pool.allocation;
    let nextWeights: Weights | undefined;
    if (mode === 'explore' && pool.mode !== 'explore') {
      const live = orderArms(arms.filter(a => a.status === 'active').map(a => ({ ...a, addedAt: new Date(a.addedAt) })));
      const now = new Date();
      const evidence = await loadPoolEvidence({ id: pool.id, surface: pool.surface, arms: live }, now);
      allocation = enterExploreAllocation({
        surface: pool.surface,
        current: pool.allocation,
        gradingHealthy: true,
        arms: live.map(a => ({
          id: a.id, role: a.role,
          ageDays: Math.floor((now.getTime() - a.addedAt.getTime()) / 86_400_000),
          evidence: evidence.get(a.id)!,
        })),
      });
    } else if (weightsPatch !== undefined) {
      const active = arms.filter(a => a.status === 'active');
      for (const armId of Object.keys(weightsPatch)) {
        if (!active.some(a => a.id === armId)) return NextResponse.json({ error: `arm ${armId} is not an active arm of this pool` }, { status: 400 });
      }
      const armOrder = active
        .slice()
        .sort((a, b) => (a.role === 'incumbent' ? -1 : b.role === 'incumbent' ? 1 : new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime()))
        .map(a => a.id);
      const backfilled = backfillWeights(pool.weights ?? {}, active.map(a => ({ id: a.id, share: allocation[a.id] ?? (a.role === 'incumbent' ? 1 : 0) })));
      nextWeights = { ...backfilled, ...weightsPatch };
      const shares = sharesFromWeights(nextWeights, armOrder);
      if (!shares.ok) return NextResponse.json({ error: shares.error }, { status: 400 });
      const check = validateAllocation(shares.allocation, arms as PoolArmRef[], undefined, { mode: 'split' });
      if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
      allocation = check.allocation;
    }

    const version = await writeAllocation({
      teamId: access.teamId, poolId: id, expectedVersion, allocation,
      ...(nextWeights !== undefined ? { weights: nextWeights } : {}),
      ...(mode ? { mode } : {}),
      kind: weightsPatch !== undefined ? 'allocation' : 'mode',
      actorUserId: access.userId,
    });
    if (version === null) {
      return NextResponse.json({ error: 'Traffic changed since you loaded this screen. Reload and try again.', code: 'stale' }, { status: 409 });
    }
    invalidateTierPoolCache(access.teamId);
    return NextResponse.json({ ok: true, allocationVersion: version, allocation, weights: nextWeights ?? pool.weights, mode: mode ?? pool.mode });
  } catch (err) {
    console.error('PATCH /api/model-tiers/pools/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
