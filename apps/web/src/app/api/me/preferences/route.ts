import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { users } from '@buildd/core/db/schema';
import { getCurrentUser } from '@/lib/auth-helpers';

/**
 * GET/PATCH /api/me/preferences: the signed-in person's own display
 * preferences. One today: `showKeyboardHints`, which reveals the keycap
 * shortcut chips (1/2/3, Esc, the chat shortcut). The shortcuts themselves
 * work either way. Settings -> Profile writes it; the protected layout reads it
 * off the session user.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ showKeyboardHints: user.showKeyboardHints === true });
}

export async function PATCH(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const flag = (body as { showKeyboardHints?: unknown } | null)?.showKeyboardHints;
  if (typeof flag !== 'boolean') {
    return NextResponse.json({ error: 'showKeyboardHints must be true or false' }, { status: 400 });
  }

  await db.update(users).set({ showKeyboardHints: flag, updatedAt: new Date() }).where(eq(users.id, user.id));
  return NextResponse.json({ showKeyboardHints: flag });
}
