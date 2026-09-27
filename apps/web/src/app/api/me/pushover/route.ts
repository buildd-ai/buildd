import { NextRequest, NextResponse } from 'next/server';
import { deletePersonalPushover, getPersonalPushover, setPersonalPushover } from '@/lib/personal-pushover';
import { resolvePushoverCaller } from './caller';

/**
 * Your own Pushover key: where alerts for things you watch go when you are
 * away (lib/personal-pushover.ts, lib/away-delivery.ts).
 *
 *   GET    /api/me/pushover?teamId=          -> { key: PersonalPushoverStatus | null }
 *   PUT    /api/me/pushover { teamId?, value } -> { key }   (checked with Pushover first)
 *   DELETE /api/me/pushover?teamId=          -> { deleted }
 *   POST   /api/me/pushover/test { teamId? } -> { ok, error }
 *
 * Only ever the caller's own row. The key never comes back beyond last4.
 */
export async function GET(req: NextRequest) {
  const c = await resolvePushoverCaller(req, req.nextUrl.searchParams.get('teamId'));
  if ('response' in c) return c.response;
  return NextResponse.json({ key: await getPersonalPushover(c.userId, c.teamId) });
}

export async function PUT(req: NextRequest) {
  let body: { teamId?: unknown; value?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const c = await resolvePushoverCaller(req, typeof body.teamId === 'string' ? body.teamId : null);
  if ('response' in c) return c.response;
  if (typeof body.value !== 'string' || !body.value.trim()) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 });
  }
  try {
    const r = await setPersonalPushover({ userId: c.userId, teamId: c.teamId, value: body.value });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ key: r.key });
  } catch (err) {
    console.error('[me/pushover] save failed:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ error: 'Could not save the key' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const c = await resolvePushoverCaller(req, req.nextUrl.searchParams.get('teamId'));
  if ('response' in c) return c.response;
  return NextResponse.json({ deleted: await deletePersonalPushover(c.userId, c.teamId) });
}
