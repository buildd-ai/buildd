import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';

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
    const allAccounts = await db.query.accounts.findMany({
      where: eq(accounts.ownerId, user.id),
      orderBy: desc(accounts.createdAt),
    });

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
    const { name, type, authType, maxConcurrentWorkers, level } = body;

    if (!name || !type) {
      return NextResponse.json({ error: 'Name and type are required' }, { status: 400 });
    }

    const plaintextKey = generateApiKey();

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
        ownerId: user.id,
      })
      .returning();

    // Return plaintext key once - it won't be retrievable after this
    return NextResponse.json({ ...account, apiKey: plaintextKey });
  } catch (error) {
    console.error('Create account error:', error);
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
  }
}
