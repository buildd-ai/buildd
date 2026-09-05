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
// Auth: Bearer token matching CRON_SECRET env var.

import { NextRequest, NextResponse } from 'next/server';
import { reconcileStalePrWorkers, sweepMissionIntegrationPrs } from '@/lib/pr-reconcile';
import { sweepDeadZonePrs } from '@/lib/dead-zone-sweep';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const mergeStateOnly = req.nextUrl.searchParams.get('scope') === 'merge-state';

  try {
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
    return NextResponse.json({
      ok: true,
      scope: mergeStateOnly ? 'merge-state' : 'full',
      reconcile,
      deadZone,
      missionPrs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[PrReconcile] error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
