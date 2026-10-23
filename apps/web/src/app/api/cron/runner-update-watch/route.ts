/**
 * GET /api/cron/runner-update-watch
 *
 * A runner that goes quiet while it updates (spec 47c97f48, R-6 and R-7;
 * lib/runner-update-watch.ts): tells the team once that the update is stuck,
 * and after an hour of silence releases the tasks it paused for the update as
 * new attempts from their pushed checkpoints.
 *
 * `?gate=due` every 5 minutes: reads `buildd:due:runner-update`, which the
 * heartbeat marks while a runner reports an update, and returns without
 * touching Postgres when nothing is due. The hourly maintenance tick runs the
 * same sweep as the floor.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { gateOnDueQueue } from '@/lib/cron-due-queue';
import { RUNNER_UPDATE_DUE_QUEUE, createUpdateWatchDeps, runUpdateWatch } from '@/lib/runner-update-watch';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withCronRun('runner-update-watch', req, async report => {
    const gate = await gateOnDueQueue(RUNNER_UPDATE_DUE_QUEUE, req.nextUrl.searchParams);
    if (!gate.proceed) {
      return NextResponse.json({ ok: true, gated: true, reason: gate.reason });
    }
    const counts = await runUpdateWatch(createUpdateWatchDeps());
    report({ processed: counts.runners, changed: counts.notified + counts.released, result: { ...counts, gate: gate.reason } });
    return NextResponse.json({ ok: true, ...counts });
  });
}
