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
// Also sweeps releases stuck in `dispatched` (no matching workflow_run ever
// arrived, so the row would otherwise never reach a terminal state and would
// block re-releasing that commit) and in `deploying`: verifyReleaseDeployment only ever
// runs once, fire-and-forget, when a release enters `deploying` (see
// advanceReleaseStateFromWorkflowRun in the github webhook route). If that one
// attempt no-ops (e.g. releaseConfig.verificationUrl was unset at the time) or
// never runs (e.g. the fire-and-forget timer got dropped), nothing else ever
// revisits the row — it sits in `deploying` forever. This sweep retries
// verification for releases stuck past RETRY_STALE_MINUTES, and gives up
// (state='failed') for ones stuck past HARD_FAIL_STALE_HOURS so the release
// reaches a terminal state instead of hanging indefinitely.
//
// Also sweeps `pending_external`: a gated release sits here while its release
// PR awaits merge into prodBranch (see advanceReleaseStateFromWorkflowRun in
// the github webhook route). If that PR closes without merging, nothing else
// ever revisits the row — it's outside both sweeps above, whose state filters
// are exact — and record.ts's non-forced idempotency check keeps treating it
// as in-flight, blocking any future non-forced re-dispatch of that commit.
// Before failing a row it asks GitHub whether a merged release PR contains
// the row's sha; if one does, the merge event was missed and the row is
// healed to `deploying` instead.
//
// Also sweeps `degraded` releases whose failure reason is a sha mismatch:
// main advances continuously, so a later legitimate merge can land on top of
// a release's own headSha during the watch window, making the deploy-identity
// endpoint report a *newer* sha and tripping the mismatch check even though
// production is fine. probeAndDegrade checks GitHub ancestry before degrading
// to stop new false positives; this sweep re-checks ancestry for rows that
// already degraded and heals them back to `healthy` once confirmed.
//
// Trigger: cron-manifest.json (external scheduler). Vercel-native crons do not
// fire in this project, so nothing may be parked in vercel.json.
// Auth: Bearer token matching CRON_SECRET env var.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { releases, workspaces } from '@buildd/core/db/schema';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { probeAndDegrade, healSupersededRelease, type RepoIdentity } from '@/lib/release-health-watcher';
import { verifyReleaseDeployment } from '@/lib/release-verification';
import { releaseWatchWindowMinutes } from '@/lib/cron-cadence';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { WORKSPACE_INSTALLATION_WITH, pickWorkspaceRepoIdentity } from '@/lib/workspace-installation';
import { findMergedReleasePrContaining, advanceGatedRowForMerge, versionFromReleasePrTitle } from '@/lib/release/gated-merge';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';

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

// Resolved once per row rather than joined into the main candidates query —
// only the sha-mismatch branch (a minority of probes) ever needs it, and the
// repo-mediated installation pointer requires the relational `with` shape
// (see workspace-installation.ts), which a hand-written innerJoin can't express.
async function resolveRepoIdentity(workspaceId: string): Promise<RepoIdentity> {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { id: true, repo: true, githubInstallationId: true, githubRepoId: true },
    with: WORKSPACE_INSTALLATION_WITH,
  });
  const identity = pickWorkspaceRepoIdentity(workspace);
  return { installationId: identity.installationId, fullName: identity.fullName };
}

async function runCronJob(req: NextRequest, report: CronReport): Promise<NextResponse> {

  const windowStart = new Date(Date.now() - WATCH_WINDOW_MINUTES * 60_000);

  const candidates = await db
    .select({
      id: releases.id,
      workspaceId: releases.workspaceId,
      verificationStrategy: releases.verificationStrategy,
      deployUrl: releases.deployUrl,
      headSha: releases.headSha,
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
    const repoIdentity = await resolveRepoIdentity(row.workspaceId);
    const outcome = await probeAndDegrade(
      {
        id: row.id,
        workspaceId: row.workspaceId,
        verificationStrategy: row.verificationStrategy,
        deployUrl: row.deployUrl,
        headSha: row.headSha,
        healthyAt: row.healthyAt,
      },
      row.verificationUrl,
      db,
      repoIdentity,
    );

    if (outcome === 'degraded') degraded++;
    results.push({ releaseId: row.id, outcome });
  }

  const retryStaleCutoff = new Date(Date.now() - RETRY_STALE_MINUTES * 60_000);
  const hardFailCutoff = new Date(Date.now() - HARD_FAIL_STALE_HOURS * 3_600_000);

  // Stale 'deploying' sweep — see file header.
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

  // Stale 'dispatched' sweep.
  //
  // A dispatched row is waiting for its workflow_run webhook. If that event
  // never matches — the readback resolved no run url, or resolved a stale one,
  // or the delivery was simply lost — nothing else ever revisits the row: the
  // sweep above only looks at `deploying`, and `verifyReleaseDeployment`
  // early-returns unless the state is exactly `deploying`. The row then sits in
  // `dispatched` forever AND blocks every future non-forced release of that
  // commit, because the trigger route's dedup check treats `dispatched` as
  // in-flight. One production row sat here through 25 consecutive green runs of
  // this very job.
  //
  // There is nothing to retry from here (the run may not exist at all), so the
  // only correct move is to let it reach a terminal state and say why.
  const staleDispatched = await db
    .select({ id: releases.id, workspaceId: releases.workspaceId, dispatchedAt: releases.dispatchedAt })
    .from(releases)
    .where(and(eq(releases.state, 'dispatched'), lt(releases.dispatchedAt, hardFailCutoff)));

  let dispatchedHardFailed = 0;
  for (const row of staleDispatched) {
    const [updated] = await db
      .update(releases)
      .set({
        state: 'failed',
        failureReason:
          `never advanced past 'dispatched' within ${HARD_FAIL_STALE_HOURS}h — ` +
          `no matching workflow_run was received, so the dispatch outcome is unknown`,
      })
      .where(and(eq(releases.id, row.id), eq(releases.state, 'dispatched')))
      .returning({ id: releases.id });

    if (updated) {
      dispatchedHardFailed++;
      await triggerEvent(channels.workspace(row.workspaceId), events.RELEASE_UPDATED, {
        releaseId: row.id,
        state: 'failed',
      });
    }
  }

  // Stale 'pending_external' sweep.
  //
  // A `pending_external` row means a gated release's dispatch succeeded and
  // is now waiting on its release PR merging into prodBranch — see
  // advanceReleaseStateFromWorkflowRun in the github webhook route. If that
  // PR is closed without merging (superseded by a newer commit, abandoned
  // after CI failure), nothing else ever revisits the row: the sweeps above
  // filter on the exact state 'dispatched' or 'deploying', not this one, and
  // `pending_external` is treated as in-flight by record.ts's non-forced
  // idempotency check — leaving the row stuck here would silently block any
  // future non-forced release of that commit.
  //
  // As with stale 'dispatched', there is nothing to retry (the PR may no
  // longer exist), so the only correct move is to let it reach a terminal
  // state and say why.
  //
  // But "never merged" must be checked, not assumed. The merge webhook used to
  // match on an exact sha the release PR head never has, so every gated row
  // reached this sweep and was failed as unmerged after its PR had merged.
  // Ask GitHub first: a merged release PR that contains the row's sha means
  // the release shipped and the event was missed — heal the row instead.
  const stalePendingExternal = await db
    .select({
      id: releases.id,
      workspaceId: releases.workspaceId,
      dispatchedAt: releases.dispatchedAt,
      headSha: releases.headSha,
    })
    .from(releases)
    .where(and(eq(releases.state, 'pending_external'), lt(releases.dispatchedAt, hardFailCutoff)));

  let pendingExternalHardFailed = 0;
  let pendingExternalHealed = 0;
  for (const row of stalePendingExternal) {
    const merged = await findMergedReleasePrForRow(row);
    if (merged && merged !== 'unknown') {
      const advanced = await advanceGatedRowForMerge({
        releaseId: row.id,
        workspaceId: row.workspaceId,
        mergeCommitSha: merged.mergeCommitSha,
        version: versionFromReleasePrTitle(merged.title),
      });
      if (advanced) pendingExternalHealed++;
      // Lost the CAS: the row already moved on; nothing to fail.
      continue;
    }

    const why =
      merged === 'unknown'
        ? `could not check whether a merged release PR contains ${row.headSha ?? 'its head sha'}`
        : `no merged release PR contains ${row.headSha}`;
    const [updated] = await db
      .update(releases)
      .set({
        state: 'failed',
        failureReason: `never advanced past 'pending_external' within ${HARD_FAIL_STALE_HOURS}h — ${why}`,
      })
      .where(and(eq(releases.id, row.id), eq(releases.state, 'pending_external')))
      .returning({ id: releases.id });

    if (updated) {
      pendingExternalHardFailed++;
      await triggerEvent(channels.workspace(row.workspaceId), events.RELEASE_UPDATED, {
        releaseId: row.id,
        state: 'failed',
      });
    }
  }

  // Self-heal sweep: a release degraded on a sha mismatch can be a false
  // positive — a later legitimate merge landed on top of it mid-watch-window,
  // and the mismatch is really "production moved forward", not "production
  // broke". probeAndDegrade's own ancestry check (above) prevents new false
  // positives, but this covers rows that already degraded before that check
  // existed, or before a supersession could be confirmed at the time. Scoped
  // to the same hard-fail lookback as the sweeps above so it doesn't rescan
  // ancient degraded rows on every tick, and to the sha-mismatch reason
  // specifically — an HTTP-error or network-error degradation describes the
  // endpoint itself failing, which no sha comparison can exonerate.
  const healableDegraded = await db
    .select({
      id: releases.id,
      workspaceId: releases.workspaceId,
      verificationStrategy: releases.verificationStrategy,
      deployUrl: releases.deployUrl,
      headSha: releases.headSha,
      healthyAt: releases.healthyAt,
      verificationUrl: sql<string | null>`${workspaces.releaseConfig}->>'verificationUrl'`,
    })
    .from(releases)
    .innerJoin(workspaces, eq(releases.workspaceId, workspaces.id))
    .where(
      and(
        eq(releases.state, 'degraded'),
        eq(releases.verificationStrategy, 'http'),
        gte(releases.healthyAt, hardFailCutoff),
        sql`${releases.failureReason} LIKE 'deployed sha % does not match release head sha %'`,
      ),
    );

  let healed = 0;
  for (const row of healableDegraded) {
    if (!row.verificationUrl) continue;
    const repoIdentity = await resolveRepoIdentity(row.workspaceId);
    const outcome = await healSupersededRelease(
      {
        id: row.id,
        workspaceId: row.workspaceId,
        verificationStrategy: row.verificationStrategy,
        deployUrl: row.deployUrl,
        headSha: row.headSha,
        healthyAt: row.healthyAt,
      },
      row.verificationUrl,
      db,
      repoIdentity,
    );
    if (outcome === 'healed') healed++;
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
      staleDispatched: staleDispatched.length,
      dispatchedHardFailed,
      stalePendingExternal: stalePendingExternal.length,
      pendingExternalHardFailed,
      healableDegraded: healableDegraded.length,
      healed,
      pendingExternalHealed,
    }),
  );

  // The verdict, not just a heartbeat. This sweep's whole purpose is to catch
  // releases that stalled silently, so a run of it that accomplishes nothing
  // must be legible as such — otherwise the watcher has the same failure mode
  // it was built to detect.
  report({
    processed:
      candidates.length +
      staleDeploying.length +
      staleDispatched.length +
      stalePendingExternal.length +
      healableDegraded.length,
    changed:
      degraded + staleRetried + staleHardFailed + dispatchedHardFailed + pendingExternalHardFailed +
      pendingExternalHealed + healed,
    result: {
      probed,
      degraded,
      staleDeploying: staleDeploying.length,
      staleRetried,
      staleHardFailed,
      staleDispatched: staleDispatched.length,
      dispatchedHardFailed,
      stalePendingExternal: stalePendingExternal.length,
      pendingExternalHardFailed,
      pendingExternalHealed,
      healableDegraded: healableDegraded.length,
      healed,
    },
  });

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    probed,
    degraded,
    results,
    staleDeploying: staleDeploying.length,
    staleRetried,
    staleHardFailed,
    staleDispatched: staleDispatched.length,
    dispatchedHardFailed,
    stalePendingExternal: stalePendingExternal.length,
    pendingExternalHardFailed,
    pendingExternalHealed,
    healableDegraded: healableDegraded.length,
    healed,
  });
}

// Did a release PR that contains this row's sha merge after it was dispatched?
// null = checked, none did. 'unknown' = could not check (no repo identity, no
// release config, no sha, or GitHub did not answer).
async function findMergedReleasePrForRow(row: {
  workspaceId: string;
  headSha: string | null;
  dispatchedAt: Date | null;
}): ReturnType<typeof findMergedReleasePrContaining> {
  if (!row.headSha) return 'unknown';
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, row.workspaceId),
    columns: { id: true, repo: true, githubInstallationId: true, githubRepoId: true, releaseConfig: true },
    with: WORKSPACE_INSTALLATION_WITH,
  });
  const config = (workspace?.releaseConfig ?? null) as WorkspaceReleaseConfig | null;
  const headRef = config?.releaseBranch ?? config?.ref;
  if (!config?.prodBranch || !headRef) return 'unknown';
  const identity = pickWorkspaceRepoIdentity(workspace);
  return findMergedReleasePrContaining({
    installationId: identity.installationId,
    repoFullName: identity.fullName,
    prodBranch: config.prodBranch,
    headRef,
    sha: row.headSha,
    since: row.dispatchedAt,
  });
}
