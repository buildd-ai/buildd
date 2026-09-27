// Cron endpoint: GET /api/cron/notify-away
//
// Pushes pending watch events to a person's own Pushover key when they are
// away (lib/away-delivery.ts has the rules and the why).
//
// Auth: Bearer CRON_SECRET, via withCronRun. Two triggers in cron-manifest.json
// (the lib/cron-due-queue.ts pattern):
//   - `?gate=due` every 2 minutes. Reads the `notify-away` Redis due-queue,
//     written by recordEvent for each new ledger row, and returns without
//     touching Postgres unless a row is due. This is the latency path.
//   - no param, hourly: the floor tick. Runs regardless, so a lost queue write
//     costs at most an hour, and rows left pending while their owner was
//     present get pushed once they have gone.

import { NextRequest, NextResponse } from 'next/server';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { gateOnDueQueue } from '@/lib/cron-due-queue';
import { AWAY_QUEUE, deliverAwayNotifications } from '@/lib/away-delivery';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withCronRun('notify-away', req, report => run(req, report));
}

async function run(req: NextRequest, report: CronReport): Promise<NextResponse> {
  const gate = await gateOnDueQueue(AWAY_QUEUE, req.nextUrl.searchParams);
  if (!gate.proceed) return NextResponse.json({ gated: true, reason: gate.reason });

  const summary = await deliverAwayNotifications();
  const result = { ...summary, gate: gate.reason };
  report({ processed: summary.rows, changed: summary.sent, errors: summary.failed, result });
  return NextResponse.json(result);
}
