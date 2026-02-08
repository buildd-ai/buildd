import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { deviceCodes } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';

// POST /api/auth/device/token
// No auth required. CLI polls this with device_token.
// Returns:
//   428 if pending (CLI keeps polling)
//   200 with { api_key } if approved (clears plaintext from DB)
//   400 if expired or invalid
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { device_token } = body;

    if (!device_token) {
      return NextResponse.json({ error: 'device_token required' }, { status: 400 });
    }

    const record = await db.query.deviceCodes.findFirst({
      where: eq(deviceCodes.deviceToken, device_token),
    });

    if (!record) {
      return NextResponse.json({ error: 'Invalid device token' }, { status: 400 });
    }

    // Check expiry
    if (new Date() > record.expiresAt) {
      // Mark as expired
      await db.update(deviceCodes)
        .set({ status: 'expired' })
        .where(eq(deviceCodes.id, record.id));
      return NextResponse.json({ error: 'Device code expired' }, { status: 400 });
    }

    if (record.status === 'expired') {
      return NextResponse.json({ error: 'Device code expired' }, { status: 400 });
    }

    if (record.status === 'pending') {
      // 428 Precondition Required — authorization pending
      return NextResponse.json({ error: 'authorization_pending' }, { status: 428 });
    }

    if (record.status === 'approved' && record.apiKey) {
      const apiKey = record.apiKey;

      // Clear the plaintext key from DB (one-time retrieval)
      await db.update(deviceCodes)
        .set({ apiKey: null })
        .where(eq(deviceCodes.id, record.id));

      // Look up user email for display
      let email: string | undefined;
      if (record.userId) {
        const { users } = await import('@buildd/core/db/schema');
        const user = await db.query.users.findFirst({
          where: eq(users.id, record.userId),
        });
        email = user?.email;
      }

      return NextResponse.json({ api_key: apiKey, email });
    }

    return NextResponse.json({ error: 'Unexpected state' }, { status: 400 });
  } catch (error) {
    console.error('Device token poll error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
