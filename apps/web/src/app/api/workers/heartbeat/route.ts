import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats, accountWorkspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { randomBytes } from 'crypto';

/**
 * POST /api/workers/heartbeat
 *
 * Called by local-ui instances every 30s to announce availability.
 * Upserts a heartbeat record so the dashboard knows this instance is alive
 * and ready to accept tasks, even if it has no active workers.
 *
 * Returns a viewerToken that the local-ui should require on its
 * /api/* endpoints. The dashboard retrieves this token via /api/workers/active
 * and passes it to the browser so it can fetch live data directly.
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

    // Check if this instance already has a viewerToken
    const existing = await db.query.workerHeartbeats.findFirst({
      where: and(
        eq(workerHeartbeats.accountId, account.id),
        eq(workerHeartbeats.localUiUrl, localUiUrl),
      ),
      columns: { viewerToken: true },
    });

    // Generate token on first registration, reuse on subsequent heartbeats
    const viewerToken = existing?.viewerToken || randomBytes(24).toString('base64url');

    // Atomic upsert using unique index on (accountId, localUiUrl)
    await db.insert(workerHeartbeats)
      .values({
        accountId: account.id,
        localUiUrl,
        viewerToken,
        workspaceIds,
        maxConcurrentWorkers: account.maxConcurrentWorkers,
        activeWorkerCount,
        lastHeartbeatAt: now,
      })
      .onConflictDoUpdate({
        target: [workerHeartbeats.accountId, workerHeartbeats.localUiUrl],
        set: {
          workspaceIds,
          maxConcurrentWorkers: account.maxConcurrentWorkers,
          activeWorkerCount,
          lastHeartbeatAt: now,
          updatedAt: now,
        },
      });

    return NextResponse.json({ ok: true, viewerToken });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return NextResponse.json({ error: 'Failed to process heartbeat' }, { status: 500 });
  }
}
