import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { cancelSubscription } from '@/lib/subscriptions';
import { isUuid } from '@/lib/uuid';

type Ctx = { params: Promise<{ id: string }> };


/** DELETE /api/subscriptions/[id] — stop one of the caller's own watches. 404 when it isn't theirs or already ended. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const s = await requireSessionUser(req);
  if (s.response) return s.response;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Watch not found' }, { status: 404 });
  const ok = await cancelSubscription({ userId: s.user.id }, id);
  if (!ok) return NextResponse.json({ error: 'Watch not found' }, { status: 404 });
  return NextResponse.json({ ok: true, id });
}
