import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-auth';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getSecretsProvider } from '@buildd/core/secrets';

// GET /api/workers/secret/[ref] — redeem a single-use secret reference
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ref: string }> }
) {
  const { ref } = await params;

  // Authenticate via API key
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // Worker ID from query param (the worker redeeming the ref)
  const workerId = req.nextUrl.searchParams.get('workerId');
  if (!workerId) {
    return NextResponse.json({ error: 'workerId is required' }, { status: 400 });
  }

  // Verify the worker belongs to this account
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    columns: { id: true, accountId: true },
  });

  if (!worker || worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  try {
    const provider = getSecretsProvider();
    const value = await provider.redeemRef(ref, workerId);

    if (!value) {
      return NextResponse.json(
        { error: 'Secret ref expired, already redeemed, or wrong scope' },
        { status: 410 }
      );
    }

    return NextResponse.json({ value });
  } catch (error) {
    console.error('Redeem secret ref error:', error);
    return NextResponse.json({ error: 'Failed to redeem secret' }, { status: 500 });
  }
}
