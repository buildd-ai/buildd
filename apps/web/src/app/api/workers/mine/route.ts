import { type WorkerStatusValue } from '@buildd/shared';
import { constrainToGranted, isGrantSession } from '@/lib/grant-scope';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { claimingUserId } from '@/lib/worker-owner';

// GET /api/workers/mine - List workers for the authenticated account
// Query params:
//   status - comma-separated status filter (e.g. "running,starting")
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey, req);

  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status');

  const conditions = [eq(workers.accountId, account.id)];
  // A grant session shares its team's session account: list only workers in
  // the workspaces it was granted (lib/grant-scope.ts).
  if (isGrantSession(account)) conditions.push(inArray(workers.workspaceId, constrainToGranted(account, account.workspaceIds ?? [])));
  // ...and only the ones its own user claimed: every grant session in the
  // team shares that account, person or agent (lib/worker-owner.ts).
  if (isGrantSession(account)) {
    const owner = claimingUserId(account);
    conditions.push(owner ? eq(workers.claimedByUserId, owner) : sql`false`);
  }
  if (status) {
    conditions.push(inArray(workers.status, status.split(',') as WorkerStatusValue[]));
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
