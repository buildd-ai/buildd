// GET /api/cron/release-health-check
//
// Post-deploy health watch window: for every release that reached `healthy`
// within the watch window with an http verification strategy, probe the
// workspace's verificationUrl once. On non-2xx or network error, transition
// the release to `degraded` and auto-file a degradation task in the workspace.
//
// The window is derived from this job's declared cadence, not hand-typed: a
// window narrower than the poll interval silently skips every release that
// lands in the gap (see apps/web/src/lib/cron-cadence.ts).
//
// Also sweeps releases stuck in `deploying`: verifyReleaseDeployment only ever
// runs once, fire-and-forget, when a release enters `deploying` (see
// advanceReleaseStateFromWorkflowRun in the github webhook route). If that one
// attempt no-ops (e.g. releaseConfig.verificationUrl was unset at the time) or
// never runs (e.g. the fire-and-forget timer got dropped), nothing else ever
// revisits the row — it sits in `deploying` forever. This sweep retries
// verification for releases stuck past RETRY_STALE_MINUTES, and gives up
// (state='failed') for ones stuck past HARD_FAIL_STALE_HOURS so the release
// reaches a terminal state instead of hanging indefinitely.
//
// Trigger: cron-manifest.json (external scheduler). Vercel-native crons do not
// fire in this project, so nothing may be parked in vercel.json.
// Auth: Bearer token matching CRON_SECRET env var.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { releases, workspaces } from '@buildd/core/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { probeAndDegrade } from '@/lib/release-health-watcher';
import { verifyReleaseDeployment } from '@/lib/release-verification';
import { releaseWatchWindowMinutes } from '@/lib/cron-cadence';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { withCronRun, type CronReport } from '@/lib/cron-run';

export const maxDuration = 60;

const WATCH_WINDOW_MINUTES = releaseWatchWindowMinutes();
// Retry cutoff, not a cadence: a release still in `deploying` this long after
// dispatch has missed its one fire-and-forget verification attempt. The actual
// retry lands on the next tick, so worst-case retry latency is this plus the
// poll interval.
const RETRY_STALE_MINUTES = 10;
const HARD_FAIL_STALE_HOURS = 24;

export async function GET(req: NextRequest) {
  return withCronRun('release-health-check', req, report => runCronJob(req, report));
}

async function runCronJob(req: NextRequest, report: CronReport): Promise<NextResponse> {

  const windowStart = new Date(Date.now() - WATCH_WINDOW_MINUTES * 60_000);

  const candidates = await db
    .select({
      id: releases.id,
      workspaceId: releases.workspaceId,
      verificationStrategy: releases.verificationStrategy,
      deployUrl: releases.deployUrl,
      healthyAt: releases.healthyAt,
      verificationUrl: sql<string | null>`${workspaces.releaseConfig}->>'verificationUrl'`,
    })
    .from(releases)
    .innerJoin(workspaces, eq(releases.workspaceId, workspaces.id))
    .where(
      and(
        eq(releases.state, 'healthy'),
        eq(releases.verificationStrategy, 'http'),
        gte(releases.healthyAt, windowStart),
      ),
    );

  let probed = 0;
  let degraded = 0;
  const results: Array<{ releaseId: string; outcome: string }> = [];

  for (const row of candidates) {
    if (!row.verificationUrl) continue;

    probed++;
    const outcome = await probeAndDegrade(
      {
        id: row.id,
        workspaceId: row.workspaceId,
        verificationStrategy: row.verificationStrategy,
        deployUrl: row.deployUrl,
        healthyAt: row.healthyAt,
      },
      row.verificationUrl,
      db,
    );

    if (outcome === 'degraded') degraded++;
    results.push({ releaseId: row.id, outcome });
  }

  // Stale 'deploying' sweep — see file header.
  const retryStaleCutoff = new Date(Date.now() - RETRY_STALE_MINUTES * 60_000);
  const hardFailCutoff = new Date(Date.now() - HARD_FAIL_STALE_HOURS * 3_600_000);

  const staleDeploying = await db
    .select({ id: releases.id, deployedAt: releases.deployedAt, workspaceId: releases.workspaceId })
    .from(releases)
    .where(
      and(
        eq(releases.state, 'deploying'),
        eq(releases.verificationStrategy, 'http'),
        lt(releases.deployedAt, retryStaleCutoff),
      ),
    );

  let staleRetried = 0;
  let staleHardFailed = 0;
  for (const row of staleDeploying) {
    if (row.deployedAt && row.deployedAt < hardFailCutoff) {
      const [updated] = await db
        .update(releases)
        .set({
          state: 'failed',
          failureReason: `stuck in 'deploying' for over ${HARD_FAIL_STALE_HOURS}h without verifying — giving up`,
        })
        .where(and(eq(releases.id, row.id), eq(releases.state, 'deploying')))
        .returning({ id: releases.id });

      if (updated) {
        staleHardFailed++;
        await triggerEvent(channels.workspace(row.workspaceId), events.RELEASE_UPDATED, {
          releaseId: row.id,
          state: 'failed',
        });
      }
    } else {
      await verifyReleaseDeployment(row.id, db);
      staleRetried++;
    }
  }

  console.log(
    JSON.stringify({
      event: 'release_health_check',
      candidates: candidates.length,
      probed,
      degraded,
      staleDeploying: staleDeploying.length,
      staleRetried,
      staleHardFailed,
    }),
  );

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    probed,
    degraded,
    results,
    staleDeploying: staleDeploying.length,
    staleRetried,
    staleHardFailed,
  });
}
