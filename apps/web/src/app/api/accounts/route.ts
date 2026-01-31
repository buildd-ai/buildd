import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { desc } from 'drizzle-orm';
import { auth } from '@/auth';
import { randomBytes } from 'crypto';

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

export async function GET() {
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ accounts: [] });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const allAccounts = await db.query.accounts.findMany({
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

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, type, authType, maxConcurrentWorkers } = body;

    if (!name || !type) {
      return NextResponse.json({ error: 'Name and type are required' }, { status: 400 });
    }

    const apiKey = generateApiKey();

    const [account] = await db
      .insert(accounts)
      .values({
        name,
        type: type as 'user' | 'service' | 'action',
        authType: authType as 'api' | 'oauth' || 'oauth',
        apiKey,
        maxConcurrentWorkers: maxConcurrentWorkers || 3,
      })
      .returning();

    return NextResponse.json(account);
  } catch (error) {
    console.error('Create account error:', error);
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
  }
}
