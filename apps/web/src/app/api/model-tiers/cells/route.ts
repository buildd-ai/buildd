import { NextRequest, NextResponse } from 'next/server';
import { isModelPolicyDial, type ModelPolicyCellsResponse } from '@buildd/shared';
import { POOL_SURFACES, tierAllowsPool, type PoolSurface } from '@buildd/core/tier-pool';
import { findTeamPool } from '@buildd/core/tier-pool-admin';
import { buildModelPolicyCells, writeDialState } from '@buildd/core/tier-dial-source';
import { applyDialChange, dialAllocation } from '@buildd/core/tier-dial';
import { invalidateTierPoolCache, readDialState } from '@buildd/core/tier-pool-source';
import { tierPoolAccess } from '@/lib/tier-pool-access';

/**
 * GET /api/model-tiers/cells?teamId= — the team's model policy read model:
 * every tier x surface cell with its primary, alternates, dial, learning state
 * (always | learning | shifted | reverted) and what ran. Members read.
 * Shape: `ModelPolicyCellsResponse` in @buildd/shared.
 */
export async function GET(req: NextRequest) {
  const access = await tierPoolAccess(new URL(req.url).searchParams.get('teamId'), false);
  if (!access.ok) return access.response;
  try {
    const body: ModelPolicyCellsResponse & { isAdmin: boolean } = {
      ...(await buildModelPolicyCells(access.teamId)),
      isAdmin: access.isAdmin,
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error('GET /api/model-tiers/cells error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/model-tiers/cells — set a cell's dial.
 * Body: { teamId, tier, surface, dial: 1..5, expectedVersion }.
 *
 * The cell's alternates are its pool's challengers (added with POST
 * /api/model-tiers/pools). Setting a dial puts the pool under the dial: an
 * exact split or explore stops, and the cell starts in `learning` (shadow) —
 * traffic only moves once the cell's own outcomes say an alternate keeps up.
 * Dial 1 returns all traffic to the primary at once. For an exact split, set
 * the pool back to `split` with PATCH /api/model-tiers/pools/[id].
 *
 * Compare-and-set on the allocation version; every change is audited.
 */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const access = await tierPoolAccess(body.teamId, true);
  if (!access.ok) return access.response;

  const { tier, surface, dial, expectedVersion } = body as { tier?: string; surface?: string; dial?: unknown; expectedVersion?: unknown };
  if (!tier || !tierAllowsPool(tier)) {
    return NextResponse.json({ error: 'tier must be premium, standard or budget (premium-plus stays on its primary)' }, { status: 400 });
  }
  if (!surface || !(POOL_SURFACES as readonly string[]).includes(surface)) {
    return NextResponse.json({ error: 'surface must be agent or chat' }, { status: 400 });
  }
  if (!isModelPolicyDial(dial)) return NextResponse.json({ error: 'dial must be 1, 2, 3, 4 or 5' }, { status: 400 });
  if (!Number.isInteger(expectedVersion)) return NextResponse.json({ error: 'expectedVersion is required' }, { status: 400 });

  try {
    const loaded = await findTeamPool(access.teamId, tier, surface as PoolSurface);
    if (!loaded) {
      return NextResponse.json({ error: 'This cell has no alternates yet. Add one first.', code: 'no_alternates' }, { status: 409 });
    }
    const { pool, arms } = loaded;
    const alternates = arms.filter(a => a.role === 'challenger' && a.status === 'active').length;
    const prior = pool.mode === 'dial' ? readDialState(pool.dialState) : null;
    const now = new Date();
    const next = applyDialChange({ prior, dial, alternates, now });
    const allocation = dialAllocation(arms, next.record, dial);
    const event = next.event ?? { kind: 'dial' as const, reason: `dial set to ${dial}`, evidence: { dial } };
    const version = await writeDialState({
      teamId: access.teamId, poolId: pool.id, expectedVersion: expectedVersion as number,
      record: next.record, allocation, event, actorUserId: access.userId, dial, mode: 'dial',
    });
    if (version === null) {
      return NextResponse.json({ error: 'Traffic changed since you loaded this screen. Reload and try again.', code: 'stale' }, { status: 409 });
    }
    invalidateTierPoolCache(access.teamId);
    return NextResponse.json({ ok: true, allocationVersion: version, dial, state: next.record.state, allocation });
  } catch (err) {
    console.error('PATCH /api/model-tiers/cells error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
