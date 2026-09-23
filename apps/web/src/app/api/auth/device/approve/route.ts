import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { deviceCodes, accounts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';
import { getUserDefaultTeamId, getUserTeamRole } from '@/lib/team-access';
import { clampKeyLevel, parseKeyLevel } from '@/lib/key-level-policy';

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

    // Create a new named account for this login. Approving never rotates or
    // returns an existing account's key, even one with the same name.
    const accountName = updated.clientName || 'CLI';
    const requestedLevel = parseKeyLevel(updated.level) || 'worker';

    const teamId = await getUserDefaultTeamId(session.user.id);
    if (!teamId) {
      return NextResponse.json({ error: 'No team found for user' }, { status: 500 });
    }

    // The key's level is capped by the approver's current role on that team.
    const role = await getUserTeamRole(session.user.id, teamId);
    if (!role) {
      return NextResponse.json({ error: 'You are not a member of this team' }, { status: 403 });
    }
    const level = clampKeyLevel(role, requestedLevel);

    const plaintextKey = generateApiKey();

    await db.insert(accounts).values({
      name: accountName,
      type: 'user',
      level,
      authType: 'api',
      apiKey: hashApiKey(plaintextKey),
      apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
      teamId,
    });

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
