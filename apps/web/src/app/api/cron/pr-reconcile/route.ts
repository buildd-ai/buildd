// GET /api/cron/pr-reconcile[?scope=merge-state]
//
// Two sweeps behind one route, on two cadences:
//
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
import { withCronRun } from '@/lib/cron-run';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const mergeStateOnly = req.nextUrl.searchParams.get('scope') === 'merge-state';
  // Two cadences are two health signals: the hourly merge-state pass and the
  // daily full pass fail independently and must not be averaged together.
  const job = mergeStateOnly ? 'pr-reconcile:merge-state' : 'pr-reconcile';

  return withCronRun(job, req, async (report) => {
    const [reconcile, deadZone, missionPrs] = await Promise.all([
      reconcileStalePrWorkers(),
      mergeStateOnly ? Promise.resolve(null) : sweepDeadZonePrs(),
      // Isolated, unlike the other two: healing merge state is the time-critical
      // half of this route, and a mission-sweep failure must not throw away
      // reconcile work that already landed in the database.
      sweepMissionIntegrationPrs().catch(err => ({
        error: err instanceof Error ? err.message : String(err),
      })),
    ]);
    console.log(
      `[PrReconcile] total=${reconcile.total} stamped=${reconcile.stamped} closed=${reconcile.closed} skipped=${reconcile.skipped} errors=${reconcile.errors} unresolvable=${reconcile.unresolvable}`,
    );
    if (deadZone) {
      console.log(
        `[DeadZoneSweep] total=${deadZone.total} sparked=${deadZone.sparked} exhausted=${deadZone.exhausted} skipped=${deadZone.skipped}`,
      );
    }
    if ('error' in missionPrs) {
      console.error('[MissionPrSweep] error:', missionPrs.error);
    }
    // `changed` is what separates a healthy idle sweep from a dead one. Rows
    // stamped merged or closed are the only real work this route does; a
    // "skipped" row is a PR that is simply still open.
    const missionPrErrors = 'error' in missionPrs ? 1 : (missionPrs.errors ?? 0);
    report({
      processed: reconcile.total + (deadZone?.total ?? 0) + ('error' in missionPrs ? 0 : missionPrs.total),
      changed:
        reconcile.stamped + reconcile.closed + reconcile.unresolvable
        + (deadZone?.sparked ?? 0) + (deadZone?.exhausted ?? 0)
        + ('error' in missionPrs ? 0 : missionPrs.opened),
      errors: reconcile.errors + missionPrErrors,
      result: { scope: mergeStateOnly ? 'merge-state' : 'full', reconcile, deadZone, missionPrs },
    });

    return NextResponse.json({
      ok: true,
      scope: mergeStateOnly ? 'merge-state' : 'full',
      reconcile,
      deadZone,
      missionPrs,
    });
  });
}
