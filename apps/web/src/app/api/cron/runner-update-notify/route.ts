/**
 * GET /api/cron/runner-update-notify
 *
 * The notifications module's half of the runner update watch (spec 47c97f48,
 * R-6 and R-7; lib/runner-update-watch.ts): tells a team once that an update
 * is stuck on one of its runners, and releases that runner's paused tasks after
 * an hour of silence, as the core maintenance floor does.
 *
 * `?gate=due` every 5 minutes: reads `buildd:due:runner-update`, which the
 * heartbeat marks while a runner reports an update, and returns without
 * touching Postgres when nothing is due.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { gateOnDueQueue } from '@/lib/cron-due-queue';
import { notifyTeam } from '@/lib/notify';
import { RUNNER_UPDATE_DUE_QUEUE, accountTeamId, createUpdateWatchDeps, runUpdateWatch } from '@/lib/runner-update-watch';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withCronRun('runner-update-notify', req, async report => {
    const gate = await gateOnDueQueue(RUNNER_UPDATE_DUE_QUEUE, req.nextUrl.searchParams);
    if (!gate.proceed) {
      return NextResponse.json({ ok: true, gated: true, reason: gate.reason });
    }
    const counts = await runUpdateWatch(createUpdateWatchDeps({
      notify: async (accountId, notice) => {
        const teamId = await accountTeamId(accountId);
        if (teamId) await notifyTeam(teamId, 'needsAttention', notice);
      },
    }));
    report({ processed: counts.runners, changed: counts.notified + counts.released, result: { ...counts, gate: gate.reason } });
    return NextResponse.json({ ok: true, ...counts });
  });
}
