import { NextRequest, NextResponse } from 'next/server';
import { requireSessionUser } from '@/lib/auth-helpers';
import { cancelSubscription } from '@/lib/subscriptions';

type Ctx = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DELETE /api/subscriptions/[id] — stop one of the caller's own watches. 404 when it isn't theirs or already ended. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const s = await requireSessionUser(req);
  if (s.response) return s.response;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Watch not found' }, { status: 404 });
  const ok = await cancelSubscription({ userId: s.user.id }, id);
  if (!ok) return NextResponse.json({ error: 'Watch not found' }, { status: 404 });
  return NextResponse.json({ ok: true, id });
}
