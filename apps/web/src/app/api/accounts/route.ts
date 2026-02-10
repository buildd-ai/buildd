import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';
import { getUserTeamIds, getUserDefaultTeamId } from '@/lib/team-access';

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

export async function GET() {
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ accounts: [] });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await getUserTeamIds(user.id);
    const allAccounts = teamIds.length > 0
      ? await db.query.accounts.findMany({
          where: inArray(accounts.teamId, teamIds),
          orderBy: desc(accounts.createdAt),
        })
      : [];

    return NextResponse.json({ accounts: allAccounts });
  } catch (error) {
    console.error('Get accounts error:', error);
    return NextResponse.json({ error: 'Failed to get accounts' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({
      id: 'dev-account',
      name: 'Dev Account',
      apiKey: 'bld_dev_key_123'
    });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, type, authType, maxConcurrentWorkers, level, teamId: requestedTeamId } = body;

    if (!name || !type) {
      return NextResponse.json({ error: 'Name and type are required' }, { status: 400 });
    }

    const plaintextKey = generateApiKey();

    // Use requested teamId if provided and user is a member, otherwise fall back to default
    let teamId: string | null = null;
    if (requestedTeamId) {
      const userTeamIds = await getUserTeamIds(user.id);
      if (userTeamIds.includes(requestedTeamId)) {
        teamId = requestedTeamId;
      }
    }
    if (!teamId) {
      teamId = await getUserDefaultTeamId(user.id);
    }
    if (!teamId) {
      return NextResponse.json({ error: 'No team found for user' }, { status: 500 });
    }

    const [account] = await db
      .insert(accounts)
      .values({
        name,
        type: type as 'user' | 'service' | 'action',
        level: level as 'worker' | 'admin' || 'worker',
        authType: authType as 'api' | 'oauth' || 'oauth',
        apiKey: hashApiKey(plaintextKey),
        apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
        maxConcurrentWorkers: maxConcurrentWorkers || 3,
        teamId,
      })
      .returning();

    // Return plaintext key once - it won't be retrievable after this
    return NextResponse.json({ ...account, apiKey: plaintextKey });
  } catch (error) {
    console.error('Create account error:', error);
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
  }
}
