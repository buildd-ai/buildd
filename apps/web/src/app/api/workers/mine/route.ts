import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';

// GET /api/workers/mine - List workers for the authenticated account
// Query params:
//   status - comma-separated status filter (e.g. "running,starting")
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status');

  const conditions = [eq(workers.accountId, account.id)];
  if (status) {
    conditions.push(inArray(workers.status, status.split(',')));
  }

  const myWorkers = await db.query.workers.findMany({
    where: and(...conditions),
    orderBy: (workers, { desc }) => [desc(workers.createdAt)],
    columns: {
      id: true,
      taskId: true,
      status: true,
      error: true,
      createdAt: true,
      updatedAt: true,
      startedAt: true,
      completedAt: true,
    },
  });

  return NextResponse.json({ workers: myWorkers });
}
