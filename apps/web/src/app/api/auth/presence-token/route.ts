/**
 * A person's presence tokens (lib/presence-token.ts).
 *
 * GET (signed-in session): this person's tokens, one per machine: label,
 * created, last used, revoked. Never a token value.
 *
 * DELETE:
 *  - with `Authorization: Bearer bldp_...`: revoke that token (`buildd logout`);
 *  - with a signed-in session and `?id=`: revoke one of this person's tokens.
 *
 * Tokens are minted only by a login (POST /api/auth/device/token, GET /api/auth/cli).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { presenceTokens } from '@buildd/core/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isPresenceToken, listPresenceTokens, revokePresenceToken } from '@/lib/presence-token';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ tokens: await listPresenceTokens(user.id) });
}

export async function DELETE(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  if (isPresenceToken(token)) {
    return NextResponse.json({ revoked: await revokePresenceToken(token) });
  }
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }
  const rows = await db.update(presenceTokens).set({ revokedAt: new Date() })
    .where(and(eq(presenceTokens.id, id), eq(presenceTokens.userId, user.id), isNull(presenceTokens.revokedAt)))
    .returning({ id: presenceTokens.id });
  return NextResponse.json({ revoked: rows.length > 0 });
}
