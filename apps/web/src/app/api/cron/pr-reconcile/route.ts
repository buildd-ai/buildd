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
//   (no scope)          daily — the above plus sweepDeadZonePrs(), which spawns
//                       conflict-resolution tasks. That one creates work, so it
//                       stays on the slower cadence.
//
// Both are bounded: reconcileStalePrWorkers caps its batch and rate-limits its
// GitHub calls, so a run finishes inside maxDuration and a backlog drains
// across runs instead of timing out mid-sweep.
//
// Auth: Bearer token matching CRON_SECRET env var.

import { NextRequest, NextResponse } from 'next/server';
import { reconcileStalePrWorkers } from '@/lib/pr-reconcile';
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
    const [reconcile, deadZone] = await Promise.all([
      reconcileStalePrWorkers(),
      mergeStateOnly ? Promise.resolve(null) : sweepDeadZonePrs(),
    ]);
    console.log(
      `[PrReconcile] total=${reconcile.total} stamped=${reconcile.stamped} closed=${reconcile.closed} skipped=${reconcile.skipped} errors=${reconcile.errors}`,
    );
    if (deadZone) {
      console.log(
        `[DeadZoneSweep] total=${deadZone.total} sparked=${deadZone.sparked} exhausted=${deadZone.exhausted} skipped=${deadZone.skipped}`,
      );
    }
    return NextResponse.json({ ok: true, scope: mergeStateOnly ? 'merge-state' : 'full', reconcile, deadZone });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[PrReconcile] error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
