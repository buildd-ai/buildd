import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workerHeartbeats, workers } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { WORKER_LEASE_TTL_MS } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';
import { randomBytes } from 'crypto';
import { getLatestVersion } from '@/lib/version-cache';

/**
 * POST /api/workers/heartbeat
 *
 * Called by runner instances every 30s to announce availability.
 * Upserts a heartbeat record so the dashboard knows this instance is alive
 * and ready to accept tasks, even if it has no active workers.
 *
 * Returns a viewerToken that the runner should require on its
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
      sandboxEnabled = null,
      sandboxProbeAt = null,
      activeWorkerIds,
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

    const sandboxProbeDate = sandboxProbeAt ? new Date(sandboxProbeAt) : null;

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
        sandboxEnabled: sandboxEnabled as boolean | null,
        sandboxProbeAt: sandboxProbeDate,
        lastHeartbeatAt: now,
      })
      .onConflictDoUpdate({
        target: [workerHeartbeats.accountId, workerHeartbeats.localUiUrl],
        set: {
          maxConcurrentWorkers: account.maxConcurrentWorkers,
          activeWorkerCount,
          environment: environment || null,
          ...(sandboxProbeDate !== null ? { sandboxEnabled: sandboxEnabled as boolean | null, sandboxProbeAt: sandboxProbeDate } : {}),
          lastHeartbeatAt: now,
          updatedAt: now,
        },
      });

    // Renew worker liveness leases.
    //
    // This is the point of the whole mechanism: the runner asserts, on a timer,
    // which workers it still owns. Renewal therefore keeps working while a
    // worker sits inside one long silent tool call, unlike `updatedAt`, which
    // only advances when the runner reports a state CHANGE and so froze exactly
    // when the agent went quiet.
    //
    // Scoped by accountId so one account's heartbeat can never extend another's
    // leases, and to live statuses so a heartbeat cannot resurrect the lease of
    // a worker that already reached a terminal state.
    let leasesRenewed = 0;
    if (Array.isArray(activeWorkerIds) && activeWorkerIds.length > 0) {
      const ids = activeWorkerIds.filter((id: unknown): id is string => typeof id === 'string');
      if (ids.length > 0) {
        try {
          const renewed = await db
            .update(workers)
            .set({ leaseExpiresAt: new Date(now.getTime() + WORKER_LEASE_TTL_MS) })
            .where(and(
              inArray(workers.id, ids),
              eq(workers.accountId, account.id),
              inArray(workers.status, ['running', 'starting', 'waiting_input', 'idle']),
            ))
            .returning({ id: workers.id });
          leasesRenewed = renewed.length;
        } catch (err) {
          // Non-fatal: a failed renewal must never break the heartbeat itself.
          // The lease simply lapses and the (still authoritative) legacy
          // staleness rule continues to govern the worker.
          console.error('[heartbeat] lease renewal failed:', err);
        }
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

    return NextResponse.json({ ok: true, viewerToken, pendingTaskCount: 0, latestCommit, leasesRenewed });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return NextResponse.json({ error: 'Failed to process heartbeat' }, { status: 500 });
  }
}
