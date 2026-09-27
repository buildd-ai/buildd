import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { recordBeat } from '@/lib/presence';

/**
 * POST /api/chat/presence  { visible: boolean, conversationId?: string }
 *
 * The chat page's presence beat (lib/presence.ts). A visible beat keeps
 * `presence:<userId>` alive for 75s; a hidden one clears it.
 *
 * No Postgres on this path: the user id comes from the JWT session, not the
 * `users` row getCurrentUser loads, because every open tab beats every 30s and
 * a DB read per beat would keep Neon awake for as long as a tab is open.
 */
export async function POST(req: NextRequest) {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { visible?: unknown; conversationId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!body || typeof body.visible !== 'boolean') {
    return NextResponse.json({ error: 'visible must be a boolean' }, { status: 400 });
  }
  const conversationId = typeof body.conversationId === 'string' && UUID.test(body.conversationId) ? body.conversationId : null;

  const { stored } = await recordBeat(userId, { visible: body.visible, conversationId });
  return NextResponse.json({ ok: true, stored });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sessionUserId(): Promise<string | null> {
  if (process.env.NODE_ENV === 'development') {
    // Dev masquerade (DEV_USER_EMAIL) lives in getCurrentUser; the DB read is fine locally.
    const { getCurrentUser } = await import('@/lib/auth-helpers');
    return (await getCurrentUser())?.id ?? null;
  }
  try {
    const session = await auth();
    return session?.user?.id || null;
  } catch {
    return null;
  }
}
