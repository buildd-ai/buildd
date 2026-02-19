import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats, tasks, workspaces, accountWorkspaces } from '@buildd/core/db/schema';
import { eq, and, or, isNull, inArray, sql } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { randomBytes } from 'crypto';
import { getLatestVersion } from '@/lib/version-cache';

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
      environment,
    } = body;

    if (!localUiUrl) {
      return NextResponse.json({ error: 'localUiUrl is required' }, { status: 400 });
    }

    // Heartbeat is just a ping - no workspace resolution needed
    // Workspaces are resolved on-demand in /api/workers/active

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
    // Only update timestamp and worker count - workspaces resolved on-demand
    await db.insert(workerHeartbeats)
      .values({
        accountId: account.id,
        localUiUrl,
        viewerToken,
        workspaceIds: [], // Deprecated - computed on-demand in /api/workers/active
        maxConcurrentWorkers: account.maxConcurrentWorkers,
        activeWorkerCount,
        environment: environment || null,
        lastHeartbeatAt: now,
      })
      .onConflictDoUpdate({
        target: [workerHeartbeats.accountId, workerHeartbeats.localUiUrl],
        set: {
          maxConcurrentWorkers: account.maxConcurrentWorkers,
          activeWorkerCount,
          environment: environment || null,
          lastHeartbeatAt: now,
          updatedAt: now,
        },
      });

    // If worker has capacity, check for pending tasks to hint at
    let pendingTaskCount = 0;
    if (activeWorkerCount < account.maxConcurrentWorkers) {
      try {
        // Resolve accessible workspaces (same pattern as claim route)
        const openWorkspaces = await db.query.workspaces.findMany({
          where: eq(workspaces.accessMode, 'open'),
          columns: { id: true },
        });
        const restrictedPermissions = await db.query.accountWorkspaces.findMany({
          where: and(
            eq(accountWorkspaces.accountId, account.id),
            eq(accountWorkspaces.canClaim, true),
          ),
          with: { workspace: { columns: { id: true, accessMode: true } } },
        });
        const openIds = openWorkspaces.map(ws => ws.id);
        const restrictedIds = restrictedPermissions
          .filter(p => p.workspace?.accessMode === 'restricted')
          .map(p => p.workspaceId);
        const workspaceIds = [...new Set([...openIds, ...restrictedIds])];

        if (workspaceIds.length > 0) {
          const [result] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(tasks)
            .where(
              and(
                eq(tasks.status, 'pending'),
                inArray(tasks.workspaceId, workspaceIds),
              )
            );
          pendingTaskCount = result?.count ?? 0;
        }
      } catch {
        // Non-fatal — just skip the count
      }
    }

    // Include latest commit SHA for auto-update checks (best-effort)
    let latestCommit: string | undefined;
    try {
      const version = await getLatestVersion();
      latestCommit = version.latestCommit;
    } catch {
      // Non-fatal — version check is optional
    }

    return NextResponse.json({ ok: true, viewerToken, pendingTaskCount, latestCommit });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return NextResponse.json({ error: 'Failed to process heartbeat' }, { status: 500 });
  }
}
