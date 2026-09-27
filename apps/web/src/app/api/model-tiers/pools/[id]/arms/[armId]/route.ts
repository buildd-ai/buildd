import { NextRequest, NextResponse } from 'next/server';
import { withoutArm } from '@buildd/core/tier-pool';
import { loadPool, removeChallenger } from '@buildd/core/tier-pool-admin';
import { invalidateTierPoolCache } from '@buildd/core/tier-pool-source';
import { tierPoolAccess } from '@/lib/tier-pool-access';

type Ctx = { params: Promise<{ id: string; armId: string }> };

/**
 * DELETE /api/model-tiers/pools/[id]/arms/[armId]?teamId=&expectedVersion=
 * Remove a challenger; its share goes back to the base model. The base model
 * itself is the registry row and cannot be removed here.
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id, armId } = await ctx.params;
  const qs = new URL(req.url).searchParams;
  const access = await tierPoolAccess(qs.get('teamId'), true);
  if (!access.ok) return access.response;
  const expectedVersion = Number(qs.get('expectedVersion'));
  if (!Number.isInteger(expectedVersion)) return NextResponse.json({ error: 'expectedVersion is required' }, { status: 400 });

  try {
    const loaded = await loadPool(access.teamId, id);
    if (!loaded) return NextResponse.json({ error: 'Pool not found' }, { status: 404 });
    const arm = loaded.arms.find(a => a.id === armId);
    const incumbent = loaded.arms.find(a => a.role === 'incumbent');
    if (!arm || !incumbent) return NextResponse.json({ error: 'Arm not found' }, { status: 404 });
    if (arm.role === 'incumbent') return NextResponse.json({ error: 'The base model cannot be removed' }, { status: 400 });

    const version = await removeChallenger({
      teamId: access.teamId, poolId: id, armId, expectedVersion,
      allocation: withoutArm(loaded.pool.allocation, armId, incumbent.id),
      actorUserId: access.userId,
    });
    if (version === null) {
      return NextResponse.json({ error: 'Traffic changed since you loaded this screen. Reload and try again.', code: 'stale' }, { status: 409 });
    }
    invalidateTierPoolCache(access.teamId);
    return NextResponse.json({ ok: true, allocationVersion: version });
  } catch (err) {
    console.error('DELETE /api/model-tiers/pools/[id]/arms/[armId] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
