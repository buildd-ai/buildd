import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, workerHeartbeats, workers } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import {
  WORKER_LEASE_TTL_MS,
  runnerFleetIdentity,
  storedHeartbeatEnvironment,
  withNormalizedRunnerHold,
  isRunnerModelAuthSource,
  isRunnerCodexAuthSource,
  parseUpdateDrain,
  nextUpdateCheckAt,
} from '@buildd/shared';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { randomBytes } from 'crypto';
import { getLatestVersion } from '@/lib/version-cache';
import { parseClaimHandoff, releaseUnacknowledgedClaims } from '@/lib/lost-claim';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { dbLeaseUntil, liveness } from '@/lib/liveness';
import { redisRunnerBeatStateStore, runnerBeatId, RUNNER_BEAT_TTL_MS } from '@/lib/runner-beats';

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
 *
 * A beat that changes nothing stays in Redis (lib/runner-beats.ts): the row,
 * and the leases of the workers it already renewed, are written when content
 * changes, when a new worker is named, or once per
 * LIVENESS_DB_WRITE_INTERVAL_MS. Without Redis every beat writes, as before.
 */
/** The most slots a runner may report (the runner's own `buildd slots` bound). */
const MAX_RUNNER_SLOTS = 50;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token (cloud container) heartbeats only as its own one-task
  // run and renews only its own task's worker.
  const account = await authenticateTaskScopedCaller(apiKey, req);

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
      runnerCommit = null,
      runnerVersion = null,
      /**
       * The branch this runner tracks (its `BUILDD_BRANCH`). Passed through
       * unvalidated on purpose: the allowlist lives in the version cache so a
       * second caller cannot forget it, and an unlisted value falls back to the
       * cache's default. Absent from older runners, which keeps today's
       * behaviour for them.
       */
      branch = undefined,
      /**
       * The same live update-state the runner reports on its own local
       * /api/version, sent as one bundle (see BuilddClient.sendHeartbeat's
       * `updateSnapshot` param) — always all six fields together, or none.
       * `undefined` (not sent) means "no snapshot on this heartbeat" (legacy
       * runner, or `git rev-parse` genuinely raced the process); `null` inside
       * the bundle for currentCommit/diskCommit is a real fact ("disk read
       * failed just now"), not "no data" — see the persistence below for why
       * they are handled differently in the upsert.
       */
      currentCommit = undefined,
      diskCommit = undefined,
      commitDrift = undefined,
      updating = undefined,
      updateAvailable = undefined,
      updateDrain = undefined,
      trackedBranch = undefined,
      /**
       * The claim → session-start acknowledgement (lib/lost-claim.ts): workers
       * this runner received but has not started yet, and whether a claim
       * request is still outstanding. Absent from older runners, whose
       * unstarted rows are left to the 5-minute never-started reap.
       */
      claimHandoff = undefined,
      /**
       * Which model login this runner's agents use, and the runner's setting
       * for it (docs/specs/runner-model-login-detect-say-report.md). Labels from a fixed
       * list; anything else (a typo, a newer label, a credential pasted by
       * mistake) is dropped here so it never reaches the table, and the beat
       * still succeeds.
       */
      // Old runners may still send a mode; it is ignored.
      modelAuthSource: rawModelAuthSource = undefined,
      /** The runner's Codex login label (same spec, R-12), under the same rules. */
      codexAuthSource: rawCodexAuthSource = undefined,
      /**
       * The runner's own slots: how many agents it runs at once (`buildd
       * slots`, + / - in top; spec c7410e76 R-43). Absent from older runners,
       * which keep the account's default here.
       */
      maxConcurrent: rawMaxConcurrent = undefined,
    } = body;
    const modelAuthSource = isRunnerModelAuthSource(rawModelAuthSource) ? rawModelAuthSource : null;
    const codexAuthSource = isRunnerCodexAuthSource(rawCodexAuthSource) ? rawCodexAuthSource : null;
    // Presence of the bundle is keyed on one field rather than requiring all
    // six, since `undefined` only ever appears here when the runner omitted
    // the whole group (buildd.ts sends it as one unit or not at all).
    const updateSnapshotProvided = trackedBranch !== undefined;

    if (!localUiUrl) {
      return NextResponse.json({ error: 'localUiUrl is required' }, { status: 400 });
    }

    // `--once` reports `headless://<host>/once/<taskId>` (apps/runner run-once.ts).
    // Any other record belongs to a long-lived runner of the same account.
    if (account.taskScope && !String(localUiUrl).endsWith(`/once/${account.taskScope.taskId}`)) {
      return NextResponse.json({ error: 'This token can only heartbeat as its own task run.' }, { status: 403 });
    }

    // Heartbeat is just a ping - no workspace resolution needed
    // Workspaces are resolved on-demand in /api/workers/active

    // A `--once` run (its per-task URL says so; nothing else uses that shape)
    // holds one task and exits: one slot, not the account's default, and its
    // fleet identity normalised so the fleet can fold it into its group. A
    // long-lived runner's environment is stored exactly as sent, minus any
    // `fleet` it claims (it cannot report itself out of the fleet).
    const fleet = runnerFleetIdentity({ localUiUrl: String(localUiUrl), environment });
    // `hold` (a person's `buildd hold`, R-35) is kept only as a valid
    // { since, until }; a lifted (null) or malformed one is dropped.
    const storedEnvironment = withNormalizedRunnerHold(storedHeartbeatEnvironment(environment, fleet));
    const reportedSlots = typeof rawMaxConcurrent === 'number' && Number.isInteger(rawMaxConcurrent) && rawMaxConcurrent >= 1 && rawMaxConcurrent <= MAX_RUNNER_SLOTS
      ? rawMaxConcurrent
      : null;
    const maxConcurrentWorkers = fleet.ephemeral ? 1 : (reportedSlots ?? account.maxConcurrentWorkers);

    const now = new Date();
    const beatId = runnerBeatId(account.id, String(localUiUrl));
    const heldIds: string[] = Array.isArray(activeWorkerIds)
      ? activeWorkerIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];

    // What the last write left, from Redis; the row only when Redis has none.
    const cached = await redisRunnerBeatStateStore.get(beatId);
    const existing = cached
      ? {
          viewerToken: cached.viewerToken,
          updateAvailable: cached.updateAvailable,
          updateAvailableSince: cached.updateAvailableSince ? new Date(cached.updateAvailableSince) : null,
        }
      : await db.query.workerHeartbeats.findFirst({
          where: sqlWhere(and(
            eq(workerHeartbeats.accountId, account.id),
            eq(workerHeartbeats.localUiUrl, localUiUrl),
          )),
          columns: { viewerToken: true, updateAvailable: true, updateAvailableSince: true },
        });

    // Generate token on first registration, reuse on subsequent heartbeats
    const viewerToken = existing?.viewerToken || randomBytes(24).toString('base64url');

    const sandboxProbeDate = sandboxProbeAt ? new Date(sandboxProbeAt) : null;

    // updateAvailableSince: stamped the moment updateAvailable first becomes
    // true, cleared the moment it stops being true, held steady while it stays
    // true across heartbeats — so it measures "since when", not "as of this
    // beat". Only touched when this heartbeat actually carries the bundle;
    // see updateSnapshotProvided above for why an omitted bundle must not
    // wipe out anything.
    const newUpdateAvailable = (updateAvailable ?? null) as boolean | null;
    const updateAvailableSince = newUpdateAvailable === true
      ? (existing?.updateAvailable === true ? existing.updateAvailableSince ?? now : now)
      : null;

    // Runner sends epoch ms; stored as ISO strings, with the phase, target and
    // paused agents of a newer runner (spec 47c97f48 R-5). Malformed input -> null.
    const storedUpdateDrain = parseUpdateDrain(updateDrain);

    // What this beat would write, bar the timestamps. Equal to the last write's
    // and naming no new worker: the beat is Redis only.
    const changes = {
      maxConcurrentWorkers,
      activeWorkerCount,
      environment: storedEnvironment,
      ...(sandboxProbeDate !== null ? { sandboxEnabled: sandboxEnabled as boolean | null, sandboxProbeAt: sandboxProbeDate } : {}),
      ...(runnerCommit !== null ? { runnerCommit: runnerCommit as string | null } : {}),
      ...(runnerVersion !== null ? { runnerVersion: runnerVersion as string | null } : {}),
      // Omitted entirely (not nulled) when the runner didn't send this
      // heartbeat's bundle, so a degraded beat can never wipe out the last
      // known-good drift/update status — same convention as runnerCommit
      // above.
      ...(updateSnapshotProvided ? {
        currentCommit: (currentCommit ?? null) as string | null,
        diskCommit: (diskCommit ?? null) as string | null,
        commitDrift: (commitDrift ?? null) as boolean | null,
        updating: (updating ?? null) as boolean | null,
        updateAvailable: newUpdateAvailable,
        updateAvailableSince,
        updateDrain: storedUpdateDrain,
        trackedBranch: (trackedBranch ?? null) as string | null,
      } : {}),
      // Omitted when not sent (or not a listed label), so an older runner
      // or a garbled beat keeps the last good value — runnerVersion's rule.
      ...(modelAuthSource !== null ? { modelAuthSource } : {}),
      ...(codexAuthSource !== null ? { codexAuthSource } : {}),
    };
    const fp = JSON.stringify(changes);
    const due = await liveness.beat('runner', beatId, now, RUNNER_BEAT_TTL_MS);
    const writeDb = due || !cached || cached.fp !== fp || heldIds.some(id => !cached.leaseIds.includes(id));

    let leasesRenewed = 0;
    if (writeDb) {
      // Atomic upsert using unique index on (accountId, localUiUrl)
      // Only update timestamp and worker count - workspaces resolved on-demand
      try {
        await db.insert(workerHeartbeats)
          .values({
            accountId: account.id,
            localUiUrl,
            viewerToken,
            workspaceIds: [], // Deprecated - computed on-demand in /api/workers/active
            maxConcurrentWorkers,
            activeWorkerCount,
            environment: storedEnvironment,
            sandboxEnabled: sandboxEnabled as boolean | null,
            sandboxProbeAt: sandboxProbeDate,
            runnerCommit: runnerCommit as string | null,
            runnerVersion: runnerVersion as string | null,
            currentCommit: (currentCommit ?? null) as string | null,
            diskCommit: (diskCommit ?? null) as string | null,
            commitDrift: (commitDrift ?? null) as boolean | null,
            updating: (updating ?? null) as boolean | null,
            updateAvailable: newUpdateAvailable,
            updateAvailableSince,
            updateDrain: storedUpdateDrain,
            trackedBranch: (trackedBranch ?? null) as string | null,
            modelAuthSource,
            codexAuthSource,
            lastHeartbeatAt: now,
          })
          .onConflictDoUpdate({
            target: [workerHeartbeats.accountId, workerHeartbeats.localUiUrl],
            set: { ...changes, lastHeartbeatAt: now, updatedAt: now },
          });
      } catch (err) {
        await liveness.writeFailed('runner', beatId);
        throw err;
      }

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
      //
      // Written with the row, so it is pushed out by the write interval as well
      // (dbLeaseUntil): it outlives the beats in between that skip it.
      let leaseIds: string[] = [];
      if (heldIds.length > 0) {
        try {
          const renewed = await db
            .update(workers)
            .set({ leaseExpiresAt: dbLeaseUntil(now, WORKER_LEASE_TTL_MS) })
            .where(and(
              inArray(workers.id, heldIds),
              eq(workers.accountId, account.id),
              ...(account.taskScope ? [eq(workers.taskId, account.taskScope.taskId)] : []),
              inArray(workers.status, ['running', 'starting', 'waiting_input', 'idle']),
            ))
            .returning({ id: workers.id });
          leasesRenewed = renewed.length;
          leaseIds = renewed.map(w => w.id);
        } catch (err) {
          // Non-fatal: a failed renewal must never break the heartbeat itself.
          // The lease simply lapses and the (still authoritative) legacy
          // staleness rule continues to govern the worker.
          console.error('[heartbeat] lease renewal failed:', err);
        }
      }
      await redisRunnerBeatStateStore.set(beatId, {
        viewerToken,
        updateAvailable: updateSnapshotProvided ? newUpdateAvailable : (existing?.updateAvailable ?? null),
        updateAvailableSince: (updateSnapshotProvided ? updateAvailableSince : (existing?.updateAvailableSince ?? null))?.toISOString() ?? null,
        fp,
        leaseIds,
      });
    } else {
      // Every worker named was renewed, by this account, by a write inside the interval.
      leasesRenewed = heldIds.length;
    }

    // An update in progress: the watch (lib/runner-update-watch.ts) looks at
    // this runner when it would turn stuck if it went quiet now (R-6, R-7).
    if (storedUpdateDrain && !account.taskScope) {
      const dueAt = nextUpdateCheckAt({ updateDrain: storedUpdateDrain, lastHeartbeatAt: now }, now.getTime());
      if (dueAt !== null) {
        const { markRunnerUpdateDue } = await import('@/lib/runner-update-watch');
        await markRunnerUpdateDue(account.id, String(localUiUrl), dueAt).catch(() => {});
      }
    }

    // Release workers minted for this runner that it says it never received
    // (lost claim response, restart between claim and start). A `--once` run
    // exits on a failed claim and never heartbeats again, so it is not asked.
    let claimsReleased = 0;
    const handoff = parseClaimHandoff(claimHandoff);
    // With nothing waiting to start and no claim on the wire, the search for a
    // lost claim rides the interval write rather than every beat.
    const handoffDue = writeDb || (handoff !== null && (handoff.pendingStartIds.length > 0 || handoff.claimInFlight));
    if (handoff && !account.taskScope && handoffDue) {
      try {
        claimsReleased = await releaseUnacknowledgedClaims({
          accountId: account.id,
          runner: String(localUiUrl),
          report: handoff,
          heldWorkerIds: heldIds,
          now,
        });
      } catch (err) {
        // Non-fatal: the never-started reap still catches the row later.
        console.error('[heartbeat] lost-claim release failed:', err);
      }
    }

    // Include latest commit SHA for auto-update checks (best-effort).
    //
    // Resolved against the runner's OWN tracked branch. Answering with another
    // branch's head advertises a commit the runner cannot reach: it resets to
    // `origin/<its branch>`, lands nowhere near the advertised SHA, and stays
    // "behind" forever.
    let latestCommit: string | undefined;
    try {
      const version = await getLatestVersion(branch);
      latestCommit = version.latestCommit;
    } catch {
      // Non-fatal — version check is optional
    }

    // A client asked this account's runners to probe their provider wall
    // (lib/budget-wall-probe.ts). Read fresh: the cached caller can be stale.
    let budgetProbeRequestedAt: string | null = null;
    try {
      const row = await db.query.accounts.findFirst({
        where: sqlWhere(eq(accounts.id, account.id)),
        columns: { budgetProbeRequestedAt: true },
      });
      budgetProbeRequestedAt = row?.budgetProbeRequestedAt?.toISOString() ?? null;
    } catch {
      // Best effort: a missed nudge is picked up by the runner's own interval.
    }

    return NextResponse.json({ ok: true, viewerToken, pendingTaskCount: 0, latestCommit, leasesRenewed, claimsReleased, budgetProbeRequestedAt });
  } catch (error) {
    console.error('Heartbeat error:', error);
    return NextResponse.json({ error: 'Failed to process heartbeat' }, { status: 500 });
  }
}
