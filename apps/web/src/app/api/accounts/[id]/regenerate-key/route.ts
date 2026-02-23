import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({
      apiKey: 'bld_dev_regenerated_key_123',
      apiKeyPrefix: 'bld_dev_rege',
    });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await getUserTeamIds(user.id);
    if (teamIds.length === 0) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Verify the account exists and belongs to one of the user's teams
    const account = await db.query.accounts.findFirst({
      where: and(eq(accounts.id, id), inArray(accounts.teamId, teamIds)),
    });

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Generate new key
    const plaintextKey = generateApiKey();
    const hashedKey = hashApiKey(plaintextKey);
    const prefix = extractApiKeyPrefix(plaintextKey);

    // Update the account with the new key
    await db
      .update(accounts)
      .set({
        apiKey: hashedKey,
        apiKeyPrefix: prefix,
      })
      .where(eq(accounts.id, id));

    return NextResponse.json({
      apiKey: plaintextKey,
      apiKeyPrefix: prefix,
    });
  } catch (error) {
    console.error('Regenerate key error:', error);
    return NextResponse.json({ error: 'Failed to regenerate key' }, { status: 500 });
  }
}
