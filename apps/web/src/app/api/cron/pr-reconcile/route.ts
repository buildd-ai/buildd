// GET /api/cron/pr-reconcile[?scope=merge-state | ?scope=landing&gate=due | ?scope=ci-red&gate=due]
//
// Sweeps behind one route, on three cadences:
//
//   ?scope=ci-red&gate=due   every few minutes — ONLY the red-PR sweep
//                       (lib/ci-red-sweep.ts), behind the same Redis due-queue
//                       gate. An open buildd PR whose CI is red with nobody
//                       fixing it gets the CI retry the webhook would have
//                       filed, or one escalation. The webhook feeds the queue
//                       when it skips a retry someone must come back to (a fix
//                       in flight that may finish without pushing). The hourly
//                       pass below runs it as the floor, like the landing sweep.
//
//   ?scope=landing&gate=due  every few minutes — ONLY the landing backstop
//                       (lib/pr-landing-sweep.ts), behind the Redis due-queue
//                       gate (lib/cron-due-queue.ts): nothing due returns
//                       before any query, so the cadence costs Redis reads and
//                       no extra Neon wake. Re-drives approved, green,
//                       unmerged PRs through landPr — the same function every
//                       landing door calls. It rides this route rather than
//                       owning one because the design (docs/design/
//                       pr-landing-guarantee.md section F) chose to: it shares
//                       the installation resolution and GitHub rate limiting
//                       the reconcile sweep already has.
//                       Without `gate=due` the scope is its own floor tick.
//   ?scope=merge-state  hourly — reconcileStalePrWorkers() only. Heals workers
//                       whose PR merged on GitHub but whose row still says
//                       otherwise (missed webhook delivery), and notifies the
//                       dependency gate so blocked tasks actually start. Merge
//                       state is time-critical: a missed delivery starves every
//                       dependent task until something corrects the row.
//                       This is the ONLY GitHub poller in the codebase — the
//                       read-through refresh in lib/pr-state-refresh.ts is a
//                       render-time fast path, not a second poller. Convergence
//                       is age-tiered (lib/pr-freshness.ts): every open worker
//                       PR is re-verified within its tier's SLA whether or not
//                       anybody opens Home.
//                       The hourly pass below also runs the landing sweep as the
//                       FLOOR: it enumerates from Postgres and re-seeds the
//                       due-queue, so a lost queue write costs an hour, not
//                       the guarantee.
//                       It also re-drives behind PRs whose branch refresh was
//                       deferred outside landing enforce (lib/refresh-redrive.ts).
//                       It also reconciles early-release decisions
//                       (dependency_releases) against the upstream PR's
//                       current state — new overlapping commits, a close
//                       without merging, or a request-changes round whose fix
//                       overlaps the dependent (lib/early-release-reconciler.ts).
//   (no scope)          daily — the above plus sweepDeadZonePrs(), which spawns
//                       conflict-resolution tasks. That one creates work, so it
//                       stays on the slower cadence.
//
// sweepMissionIntegrationPrs() runs on BOTH cadences. It is the mission PR's
// only trigger that does not require a merge event: the webhook opens the PR
// when the last task PR merges, and there are two ways that never happens —
// the delivery is lost (workers.mergedAt is documented as lossy), or the
// mission reaches completeness with no PR-merge event at all (the last
// deliverable needs no PR, or every deliverable task was cancelled). Since the
// completion gate refuses a mission whose PR is missing, leaving this to the
// daily run would hold a finished mission open for a day.
//
// Deferred-startAt wakes used to ride here too (lib/deferred-dispatch-sweep.ts).
// They are durable outbox intents now, fired on time by /api/cron/dispatch-drain.
//
// All three are bounded: reconcileStalePrWorkers caps its batch and rate-limits
// its GitHub calls, and the mission sweep caps its candidate set to opted-in
// missions inside a recency window — so a run finishes inside maxDuration and a
// backlog drains across runs instead of timing out mid-sweep.
//
// Auth + run recording: withCronRun (lib/cron-run.ts). Bearer CRON_SECRET, and
// the sweep's verdict is persisted so "running hourly, changing nothing" is
// detectable instead of being discarded here — which is how this route's own
// three sweeps stayed dead for months (PR #2125).

import { NextRequest, NextResponse } from 'next/server';
import { reconcileStalePrWorkers, sweepMissionIntegrationPrs } from '@/lib/pr-reconcile';
import { sweepDeadZonePrs } from '@/lib/dead-zone-sweep';
import { sweepStrandedTasks } from '@/lib/stranded-tasks-sweep';
import { sweepSpecDiscrepancyRechecks } from '@/lib/spec-recheck';
import { sweepDuplicateLineagePrs } from '@/lib/retry-pr-supersession';
import { sweepClosedUnsupersededPrs } from '@/lib/pr-supersession-detect';
import { MISSION_BRANCH_REFRESH_SWEEP, EARLY_RELEASE_SWEEP } from '@/modules';
import type { ReconcileEarlyReleasesResult } from '@/lib/early-release-reconciler';
import { sweepLandingPrs } from '@/lib/pr-landing-sweep-deps';
import { redriveDeferredRefreshes, type RefreshRedriveResult } from '@/lib/refresh-redrive';
import { PR_LANDING_DUE_QUEUE, type LandingSweepResult } from '@/lib/pr-landing-sweep';
import { sweepCiRedPrs } from '@/lib/ci-red-sweep-deps';
import type { CiRedSweepResult } from '@/lib/ci-red-sweep';
import { CI_RED_DUE_QUEUE } from '@/lib/ci-red-queue';
import { gateOnDueQueue } from '@/lib/cron-due-queue';
import { withCronRun, type CronReport } from '@/lib/cron-run';

export const maxDuration = 60;

/** What one landing sweep adds to a run's `changed`: PRs it actually moved. */
const landingChanged = (r: LandingSweepResult) => r.merged + r.updatingBranch + r.needsFix;
/** What one red-PR sweep adds to `changed`: retries filed and PRs handed to a human. */
const ciRedChanged = (r: CiRedSweepResult) => r.dispatched + r.escalated;

export async function GET(req: NextRequest) {
  const scope = req.nextUrl.searchParams.get('scope');
  const landingOnly = scope === 'landing';
  const ciRedOnly = scope === 'ci-red';
  const mergeStateOnly = scope === 'merge-state';
  // Separate cadences are separate health signals: the fast landing tick, the
  // hourly merge-state pass and the daily full pass fail independently and must
  // not be averaged together.
  const job = landingOnly
    ? 'pr-reconcile:landing'
    : ciRedOnly
      ? 'pr-reconcile:ci-red'
      : mergeStateOnly ? 'pr-reconcile:merge-state' : 'pr-reconcile';

  return withCronRun(job, req, async (report) => {
    if (landingOnly) return runLandingScope(req, report);
    if (ciRedOnly) return runCiRedScope(req, report);

    const [reconcile, deadZone, missionPrs, branchRefresh, stranded, specRecheck, lineagePrs, landing, refreshRedrive, ciRed, closedPrs, earlyRelease] = await Promise.all([
      reconcileStalePrWorkers(),
      mergeStateOnly ? Promise.resolve(null) : sweepDeadZonePrs(),
      // Isolated, unlike the other two: healing merge state is the time-critical
      // half of this route, and a mission-sweep failure must not throw away
      // reconcile work that already landed in the database.
      sweepMissionIntegrationPrs().catch(err => ({
        error: err instanceof Error ? err.message : String(err),
      })),
      // The backstop half of keeping mission branches current with dev
      // (lib/mission-branch-refresh.ts) — covers a lost webhook delivery.
      // Hourly, like merge-state healing: a mission branch left stale for a
      // full day is exactly the failure mode this exists to close. Isolated.
      MISSION_BRANCH_REFRESH_SWEEP().catch((err): { error: string } => ({
        error: err instanceof Error ? err.message : String(err),
      })),
      // Stranded-task detection has nothing to do with PRs — it rides this
      // route's hourly cadence (the merge-state scope) rather than a new cron.
      // Isolated for the same reason as the mission sweep above.
      sweepStrandedTasks().catch(err => ({
        error: err instanceof Error ? err.message : String(err),
      })),
      // Merged doc fixes whose ledger rows were never rechecked get a forced
      // re-run; rechecked-and-still-open ones get their one follow-up
      // (lib/spec-recheck.ts). Hourly, like merge state — it acts on merges.
      sweepSpecDiscrepancyRechecks().catch(err => ({
        error: err instanceof Error ? err.message : String(err),
      })),
      // Two open PRs in one retry lineage: create_pr closes the parent's PR when
      // a retry opens a fresh one, and this is the retry for the closes that did
      // not happen (lib/retry-pr-supersession.ts). Hourly — a duplicate PR is
      // one merge click from shipping a rejected attempt.
      sweepDuplicateLineagePrs().catch(err => ({
        error: err instanceof Error ? err.message : String(err),
      })),
      // The landing backstop's floor pass: enumerates from Postgres and re-seeds
      // the due-queue the gated tick reads. Isolated — a landing failure must not
      // discard merge-state healing, and the reverse. Hourly, like the rest.
      sweepLandingPrs({ source: 'floor' }).catch(err => ({
        error: err instanceof Error ? err.message : String(err),
      })),
      // Behind PRs whose branch refresh was deferred by an operational failure
      // outside landing `enforce`: no event is coming, so this re-enters the
      // normal merge door, bounded per head (lib/refresh-redrive.ts). Hourly,
      // on this tick, so it opens no extra Neon wake window; isolated.
      redriveDeferredRefreshes().catch((err): { error: string } => ({
        error: err instanceof Error ? err.message : String(err),
      })),
      // The red-PR sweep's floor pass: open buildd PRs whose lifecycle is
      // ci_failed, re-seeding the queue the gated tick reads. Isolated.
      sweepCiRedPrs({ source: 'floor' }).catch((err): { error: string } => ({
        error: err instanceof Error ? err.message : String(err),
      })),
      // Closed-unmerged mission PRs with no supersession edge: look for where
      // the work landed and record it only if the content verifies, else leave
      // a suggestion (lib/pr-supersession-detect.ts). Backfill for webhook
      // misses and PRs closed before the webhook door existed. Isolated.
      sweepClosedUnsupersededPrs().catch((err): { error: string } => ({
        error: err instanceof Error ? err.message : String(err),
      })),
      // Re-checks every non-revoked early-release decision against the
      // upstream PR's current state (lib/early-release-reconciler.ts).
      // Isolated — a reconciler failure must not discard the rest of the sweep.
      EARLY_RELEASE_SWEEP().catch((err): { error: string } => ({
        error: err instanceof Error ? err.message : String(err),
      })),
    ]);
    // subjectsReconciled is NOT folded into `changed` below: the subject sweep
    // only runs on the merged/closed branches, each of which already increments
    // stamped or closed, so adding it would count one event twice. It rides in
    // `result.reconcile` for forensics and is logged here because it is the one
    // number that says how often the webhook is actually being missed.
    console.log(
      `[PrReconcile] total=${reconcile.total} stamped=${reconcile.stamped} closed=${reconcile.closed} skipped=${reconcile.skipped} errors=${reconcile.errors} unresolvable=${reconcile.unresolvable} subjectsReconciled=${reconcile.subjectsReconciled} conflictsDetected=${reconcile.conflictsDetected}`,
    );
    if (deadZone) {
      console.log(
        `[DeadZoneSweep] total=${deadZone.total} sparked=${deadZone.sparked} exhausted=${deadZone.exhausted} skipped=${deadZone.skipped}`,
      );
    }
    if ('error' in missionPrs) {
      console.error('[MissionPrSweep] error:', missionPrs.error);
    }
    if ('error' in branchRefresh) {
      console.error('[MissionBranchRefresh] error:', branchRefresh.error);
    } else {
      console.log(
        `[MissionBranchRefresh] scanned=${branchRefresh.scanned} merged=${branchRefresh.merged} conflicts=${branchRefresh.conflicts} skipped=${branchRefresh.skipped} errors=${branchRefresh.errors}`,
      );
    }
    if ('error' in stranded) {
      console.error('[StrandedSweep] error:', stranded.error);
    } else {
      console.log(`[StrandedSweep] scanned=${stranded.scanned} stranded=${stranded.stranded} cleared=${stranded.cleared}`);
    }
    if ('error' in specRecheck) {
      console.error('[SpecRecheckSweep] error:', specRecheck.error);
    } else {
      console.log(
        `[SpecRecheckSweep] candidates=${specRecheck.candidates} rechecks=${specRecheck.rechecksDispatched} covered=${specRecheck.rechecksCovered} recheckFailed=${specRecheck.rechecksFailed} followUps=${specRecheck.followUpsDispatched} followUpFailed=${specRecheck.followUpsFailed}`,
      );
    }
    if ('error' in lineagePrs) {
      console.error('[LineagePrSweep] error:', lineagePrs.error);
    } else {
      console.log(
        `[LineagePrSweep] candidates=${lineagePrs.candidates} closed=${lineagePrs.closed} stranded=${lineagePrs.stranded} skipped=${lineagePrs.skipped}`,
      );
    }
    if ('error' in landing) {
      console.error('[LandingSweep] error:', landing.error);
    } else {
      logLanding(landing);
    }
    if ('error' in refreshRedrive) {
      console.error('[RefreshRedrive] error:', refreshRedrive.error);
    } else {
      logRefreshRedrive(refreshRedrive);
    }
    if ('error' in ciRed) {
      console.error('[CiRedSweep] error:', ciRed.error);
    } else {
      logCiRed(ciRed);
    }
    if ('error' in closedPrs) {
      console.error('[ClosedPrSupersession] error:', closedPrs.error);
    } else {
      console.log(
        `[ClosedPrSupersession] candidates=${closedPrs.candidates} recorded=${closedPrs.recorded} suggested=${closedPrs.suggested} none=${closedPrs.none} skipped=${closedPrs.skipped}`,
      );
    }
    if ('error' in earlyRelease) {
      console.error('[EarlyReleaseReconciler] error:', earlyRelease.error);
    } else {
      logEarlyRelease(earlyRelease);
    }
    // `changed` is what separates a healthy idle sweep from a dead one. Rows
    // stamped merged or closed are the only real work this route does; a
    // "skipped" row is a PR that is simply still open.
    const missionPrErrors = 'error' in missionPrs ? 1 : (missionPrs.errors ?? 0);
    const branchRefreshErrors = 'error' in branchRefresh ? 1 : branchRefresh.errors;
    const strandedErrors = 'error' in stranded ? 1 : 0;
    const specRecheckErrors = 'error' in specRecheck ? 1 : specRecheck.rechecksFailed + specRecheck.followUpsFailed;
    const lineageErrors = 'error' in lineagePrs ? 1 : lineagePrs.stranded;
    const landingErrors = 'error' in landing ? 1 : landing.errors;
    const refreshRedriveErrors = 'error' in refreshRedrive ? 1 : refreshRedrive.errors;
    const ciRedErrors = 'error' in ciRed ? 1 : ciRed.errors;
    const closedPrErrors = 'error' in closedPrs ? 1 : 0;
    const earlyReleaseErrors = 'error' in earlyRelease ? 1 : earlyRelease.errors;
    report({
      processed:
        reconcile.total + (deadZone?.total ?? 0) + ('error' in missionPrs ? 0 : missionPrs.total)
        + ('error' in branchRefresh ? 0 : branchRefresh.scanned)
        + ('error' in landing ? 0 : landing.processed)
        + ('error' in refreshRedrive ? 0 : refreshRedrive.redriven)
        + ('error' in ciRed ? 0 : ciRed.processed)
        + ('error' in earlyRelease ? 0 : earlyRelease.processed),
      changed:
        reconcile.stamped + reconcile.closed + reconcile.unresolvable + reconcile.conflictsDetected
        + (deadZone?.sparked ?? 0) + (deadZone?.exhausted ?? 0)
        + ('error' in missionPrs ? 0 : missionPrs.opened)
        + ('error' in branchRefresh ? 0 : branchRefresh.merged + branchRefresh.conflicts)
        + ('error' in stranded ? 0 : stranded.stranded + stranded.cleared)
        + ('error' in specRecheck ? 0 : specRecheck.rechecksDispatched + specRecheck.followUpsDispatched)
        + ('error' in lineagePrs ? 0 : lineagePrs.closed)
        + ('error' in landing ? 0 : landingChanged(landing))
        + ('error' in refreshRedrive ? 0 : refreshRedrive.merged + refreshRedrive.exhausted)
        + ('error' in ciRed ? 0 : ciRedChanged(ciRed))
        + ('error' in closedPrs ? 0 : closedPrs.recorded + closedPrs.suggested)
        + ('error' in earlyRelease ? 0 : earlyRelease.refreshed + earlyRelease.escalated),
      errors:
        reconcile.errors + missionPrErrors + branchRefreshErrors + strandedErrors + specRecheckErrors + lineageErrors
        + landingErrors + refreshRedriveErrors + ciRedErrors + closedPrErrors + earlyReleaseErrors,
      result: { scope: mergeStateOnly ? 'merge-state' : 'full', reconcile, deadZone, missionPrs, branchRefresh, stranded, specRecheck, lineagePrs, landing, refreshRedrive, ciRed, closedPrs, earlyRelease },
    });

    return NextResponse.json({
      ok: true,
      scope: mergeStateOnly ? 'merge-state' : 'full',
      reconcile,
      deadZone,
      missionPrs,
      branchRefresh,
      stranded,
      specRecheck,
      lineagePrs,
      landing,
      refreshRedrive,
      ciRed,
      closedPrs,
      earlyRelease,
    });
  });
}

function logEarlyRelease(r: ReconcileEarlyReleasesResult): void {
  console.log(
    `[EarlyReleaseReconciler] enumerated=${r.enumerated} processed=${r.processed} refreshed=${r.refreshed} escalated=${r.escalated} ignored=${r.ignored} skipped=${r.skipped} errors=${r.errors}`,
  );
}

function logRefreshRedrive(r: RefreshRedriveResult): void {
  console.log(
    `[RefreshRedrive] enumerated=${r.enumerated} redriven=${r.redriven} merged=${r.merged} exhausted=${r.exhausted} raced=${r.raced} notRedrivable=${r.notRedrivable} deferred=${r.deferred} errors=${r.errors} outcomes=${JSON.stringify(r.outcomes)}`,
  );
}

function logLanding(r: LandingSweepResult): void {
  console.log(
    `[LandingSweep] source=${r.source} enumerated=${r.enumerated} processed=${r.processed} merged=${r.merged} updatingBranch=${r.updatingBranch} waitingCi=${r.waitingCi} needsFix=${r.needsFix} needsHuman=${r.needsHuman} headMoved=${r.headMoved} skipped=${JSON.stringify(r.skipped)} deferred=${r.deferred} truncated=${r.truncated} errors=${r.errors}`,
  );
}

/**
 * `?scope=landing`: the landing backstop alone. With `gate=due` a tick with
 * nothing due returns before any query; without it the tick is its own floor.
 */
async function runLandingScope(req: NextRequest, report: CronReport): Promise<NextResponse> {
  const gate = await gateOnDueQueue(PR_LANDING_DUE_QUEUE, req.nextUrl.searchParams);
  if (!gate.proceed) {
    return NextResponse.json({ ok: true, scope: 'landing', gated: true, reason: gate.reason });
  }

  // An unanswerable gate fails open (cron-due-queue.ts): with Redis down the due
  // queue cannot be read, so enumerate from Postgres instead of doing nothing.
  const source = gate.reseed || gate.reason === 'redis_unavailable' ? 'floor' : 'due';
  const landing = await sweepLandingPrs({ source });
  logLanding(landing);
  report({
    processed: landing.processed,
    changed: landingChanged(landing),
    errors: landing.errors,
    result: { scope: 'landing', gate: gate.reason, landing },
  });
  return NextResponse.json({ ok: true, scope: 'landing', gate: gate.reason, landing });
}

function logCiRed(r: CiRedSweepResult): void {
  console.log(
    `[CiRedSweep] source=${r.source} enumerated=${r.enumerated} processed=${r.processed} dispatched=${r.dispatched} escalated=${r.escalated} inFlight=${r.inFlight} tooYoung=${r.tooYoung} skipped=${JSON.stringify(r.skipped)} deferred=${r.deferred} truncated=${r.truncated} errors=${r.errors}`,
  );
}

/**
 * `?scope=ci-red`: the red-PR sweep alone. With `gate=due` a tick with nothing
 * due returns before any query; without it the tick is its own floor.
 */
async function runCiRedScope(req: NextRequest, report: CronReport): Promise<NextResponse> {
  const gate = await gateOnDueQueue(CI_RED_DUE_QUEUE, req.nextUrl.searchParams);
  if (!gate.proceed) {
    return NextResponse.json({ ok: true, scope: 'ci-red', gated: true, reason: gate.reason });
  }
  const source = gate.reseed || gate.reason === 'redis_unavailable' ? 'floor' : 'due';
  const ciRed = await sweepCiRedPrs({ source });
  logCiRed(ciRed);
  report({
    processed: ciRed.processed,
    changed: ciRedChanged(ciRed),
    errors: ciRed.errors,
    result: { scope: 'ci-red', gate: gate.reason, ciRed },
  });
  return NextResponse.json({ ok: true, scope: 'ci-red', gate: gate.reason, ciRed });
}
