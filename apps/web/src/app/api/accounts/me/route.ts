import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

async function authenticateApiKey(apiKey: string | null) {
  if (!apiKey) return null;

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.apiKey, apiKey),
  });

  return account || null;
}

// GET /api/accounts/me - Get current account info from API key
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // Return relevant account info (not the full account with sensitive data)
  return NextResponse.json({
    id: account.id,
    name: account.name,
    type: account.type,
    level: account.level,
    authType: account.authType,
    maxConcurrentWorkers: account.maxConcurrentWorkers,
  });
}
