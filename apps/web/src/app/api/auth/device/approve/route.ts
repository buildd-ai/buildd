import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { deviceCodes, accounts } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';
import { getUserTeamIds, getUserDefaultTeamId } from '@/lib/team-access';

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

// POST /api/auth/device/approve
// Requires session auth. User submits the human-readable code to authorize the device.
export async function POST(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { code } = body;

    if (!code || typeof code !== 'string') {
      return NextResponse.json({ error: 'code is required' }, { status: 400 });
    }

    // Normalize: uppercase, trim whitespace
    const normalizedCode = code.trim().toUpperCase();

    // Atomic update: find pending, non-expired device code and approve it
    const [updated] = await db
      .update(deviceCodes)
      .set({
        status: 'approved',
        userId: session.user.id,
      })
      .where(
        and(
          eq(deviceCodes.userCode, normalizedCode),
          eq(deviceCodes.status, 'pending'),
        )
      )
      .returning();

    if (!updated) {
      return NextResponse.json({
        error: 'Invalid or expired code. Check the code and try again.',
      }, { status: 400 });
    }

    // Check if it's actually expired (race condition guard)
    if (new Date() > updated.expiresAt) {
      await db.update(deviceCodes)
        .set({ status: 'expired' })
        .where(eq(deviceCodes.id, updated.id));
      return NextResponse.json({ error: 'Code has expired' }, { status: 400 });
    }

    // Create/update a named account for the user
    const accountName = updated.clientName || 'CLI';
    const level = updated.level as 'admin' | 'worker';

    const teamIds = await getUserTeamIds(session.user.id);
    let account = teamIds.length > 0
      ? await db.query.accounts.findFirst({
          where: and(
            inArray(accounts.teamId, teamIds),
            eq(accounts.name, accountName)
          ),
        })
      : null;

    const plaintextKey = generateApiKey();

    if (!account) {
      const teamId = await getUserDefaultTeamId(session.user.id);
      if (!teamId) {
        return NextResponse.json({ error: 'No team found for user' }, { status: 500 });
      }

      await db.insert(accounts).values({
        name: accountName,
        type: 'user',
        level,
        authType: 'api',
        apiKey: hashApiKey(plaintextKey),
        apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
        teamId,
      });
    } else {
      await db.update(accounts)
        .set({
          apiKey: hashApiKey(plaintextKey),
          apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
          level,
        })
        .where(eq(accounts.id, account.id));
    }

    // Store plaintext in device code record for CLI to retrieve
    await db.update(deviceCodes)
      .set({ apiKey: plaintextKey })
      .where(eq(deviceCodes.id, updated.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Device approve error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
