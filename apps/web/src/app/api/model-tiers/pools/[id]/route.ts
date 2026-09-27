import { NextRequest, NextResponse } from 'next/server';
import { validateAllocation, type PoolArmRef } from '@buildd/core/tier-pool';
import { listPoolChanges, loadPool, writeAllocation } from '@buildd/core/tier-pool-admin';
import { invalidateTierPoolCache } from '@buildd/core/tier-pool-source';
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
 * PATCH /api/model-tiers/pools/[id] — set traffic shares, or pin/unpin.
 * Body: { teamId, expectedVersion, allocation?: {armId: share}, mode?: 'pinned' | 'split' }.
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
  if (mode !== undefined && mode !== 'pinned' && mode !== 'split') {
    return NextResponse.json({ error: 'mode must be pinned or split' }, { status: 400 });
  }
  if (mode === undefined && body.allocation === undefined) {
    return NextResponse.json({ error: 'allocation or mode is required' }, { status: 400 });
  }

  try {
    const loaded = await loadPool(access.teamId, id);
    if (!loaded) return NextResponse.json({ error: 'Pool not found' }, { status: 404 });
    const { pool, arms } = loaded;

    let allocation = pool.allocation;
    if (body.allocation !== undefined) {
      const check = validateAllocation(body.allocation, arms as PoolArmRef[], {
        incumbentFloor: pool.incumbentFloor, explorationCap: pool.explorationCap,
      });
      if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
      allocation = check.allocation;
    }

    const version = await writeAllocation({
      teamId: access.teamId, poolId: id, expectedVersion, allocation,
      ...(mode ? { mode } : {}),
      kind: body.allocation !== undefined ? 'allocation' : 'mode',
      actorUserId: access.userId,
    });
    if (version === null) {
      return NextResponse.json({ error: 'Traffic changed since you loaded this screen. Reload and try again.', code: 'stale' }, { status: 409 });
    }
    invalidateTierPoolCache(access.teamId);
    return NextResponse.json({ ok: true, allocationVersion: version, allocation, mode: mode ?? pool.mode });
  } catch (err) {
    console.error('PATCH /api/model-tiers/pools/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
