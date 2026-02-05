import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';

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
