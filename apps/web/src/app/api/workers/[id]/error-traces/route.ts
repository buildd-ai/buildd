import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, workerErrorTraces } from '@buildd/core/db/schema';
import { eq, and, desc, gt } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';

// GET /api/workers/[id]/error-traces?since=<ISO>&limit=<n>
//
// Returns pattern-matched error excerpts captured by the runner during this
// worker's session. Used by the dashboard error-count badge and the
// get_error_traces MCP action (agents querying their own / their predecessor's
// failures during debugging).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, accountId: true, workspaceId: true },
  });
  if (!worker) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
  }

  // Access check: API key must own the worker; session user must have access
  // to the worker's workspace.
  if (apiAccount && !user) {
    if (worker.accountId !== apiAccount.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else if (user) {
    const allowed = await verifyWorkspaceAccess(user.id, worker.workspaceId);
    if (!allowed) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }
  }

  const sinceParam = req.nextUrl.searchParams.get('since');
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '100', 10) || 100, 1), 500);

  const conds = [eq(workerErrorTraces.workerId, id)];
  if (sinceParam) {
    const since = new Date(sinceParam);
    if (!isNaN(since.getTime())) conds.push(gt(workerErrorTraces.ts, since));
  }

  const traces = await db.query.workerErrorTraces.findMany({
    where: and(...conds),
    orderBy: [desc(workerErrorTraces.ts)],
    limit,
  });

  return NextResponse.json({ traces, count: traces.length });
}
