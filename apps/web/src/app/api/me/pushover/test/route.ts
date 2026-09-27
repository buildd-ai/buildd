import { NextRequest, NextResponse } from 'next/server';
import { testPersonalPushover } from '@/lib/personal-pushover';
import { resolvePushoverCaller } from '../caller';

/** POST /api/me/pushover/test { teamId? } -> { ok, error }: one real test push to your own key. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { teamId?: unknown };
  const c = await resolvePushoverCaller(req, typeof body.teamId === 'string' ? body.teamId : null);
  if ('response' in c) return c.response;
  return NextResponse.json(await testPersonalPushover(c.userId, c.teamId));
}
