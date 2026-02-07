import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats, accountWorkspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';

/**
 * POST /api/workers/heartbeat
 *
 * Called by local-ui instances every 30s to announce availability.
 * Upserts a heartbeat record so the dashboard knows this instance is alive
 * and ready to accept tasks, even if it has no active workers.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      localUiUrl,
      activeWorkerCount = 0,
    } = body;

    if (!localUiUrl) {
      return NextResponse.json({ error: 'localUiUrl is required' }, { status: 400 });
    }

    // Get workspace IDs this account has access to
    const accountWs = await db.query.accountWorkspaces.findMany({
      where: eq(accountWorkspaces.accountId, account.id),
      columns: { workspaceId: true },
    });
    const workspaceIds = accountWs.map(aw => aw.workspaceId);

    const now = new Date();

    // Upsert: try update first, insert if not found
    const existing = await db.query.workerHeartbeats.findFirst({
      where: and(
        eq(workerHeartbeats.accountId, account.id),
        eq(workerHeartbeats.localUiUrl, localUiUrl),
      ),
    });

    if (existing) {
      await db.update(workerHeartbeats)
        .set({
          workspaceIds,
          maxConcurrentWorkers: account.maxConcurrentWorkers,
          activeWorkerCount,
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(workerHeartbeats.id, existing.id));
    } else {
      await db.insert(workerHeartbeats).values({
        accountId: account.id,
        localUiUrl,
        workspaceIds,
        maxConcurrentWorkers: account.maxConcurrentWorkers,
        activeWorkerCount,
        lastHeartbeatAt: now,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return NextResponse.json({ error: 'Failed to process heartbeat' }, { status: 500 });
  }
}
