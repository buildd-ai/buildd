// Cron endpoint: GET /api/cron/notify-away
//
// Pushes pending watch events to a person's own Pushover key when they are
// away (lib/away-delivery.ts has the rules and the why), and surfaces held
// agent questions whose deadline passed (lib/question-hold.ts).
//
// Auth: Bearer CRON_SECRET, via withCronRun. Two triggers in cron-manifest.json
// (the lib/cron-due-queue.ts pattern):
//   - `?gate=due` every 2 minutes. Reads two Redis due-queues — `notify-away`,
//     written by recordEvent for each new ledger row, and `question-hold`,
//     written by the worker PATCH route when a question parks on hold — and
//     runs only the pass whose queue has something due. Neither due: returns
//     without touching Postgres. This is the latency path.
//   - no param, hourly: the floor tick. Runs both passes regardless, so a lost
//     queue write costs at most an hour, rows left pending while their owner
//     was present get pushed once they have gone, and the hold queue is
//     re-seeded from the table.
//
// Held questions ride this route rather than a cron of their own: the same
// 2-minute gated cadence fits their 15-minute deadline, and a separate job
// would be a second Redis read per tick and a second floor wake.

import { NextRequest, NextResponse } from 'next/server';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { gateOnDueQueue } from '@/lib/cron-due-queue';
import { AWAY_QUEUE, deliverAwayNotifications } from '@/lib/away-delivery';
import { HOLD_QUEUE, resurfaceHeldQuestions } from '@/lib/question-hold';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withCronRun('notify-away', req, report => run(req, report));
}

async function run(req: NextRequest, report: CronReport): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const [gate, holdGate] = await Promise.all([
    gateOnDueQueue(AWAY_QUEUE, params),
    gateOnDueQueue(HOLD_QUEUE, params),
  ]);
  if (!gate.proceed && !holdGate.proceed) return NextResponse.json({ gated: true, reason: gate.reason });

  const hold = holdGate.proceed
    ? await resurfaceHeldQuestions({ floor: holdGate.reason === 'floor' }).catch(err => {
        console.error('[Cron] notify-away: held-question pass failed:', err instanceof Error ? err.message : 'unknown');
        return null;
      })
    : undefined;
  const summary = gate.proceed ? await deliverAwayNotifications() : null;

  const result = { ...(summary ?? {}), gate: gate.reason, ...(hold !== undefined ? { hold } : {}) };
  // `changed` = real work: messages pushed plus held questions surfaced.
  report({
    processed: (summary?.rows ?? 0) + (hold?.held ?? 0),
    changed: (summary?.sent ?? 0) + (hold?.resurfaced ?? 0),
    errors: (summary?.failed ?? 0) + (hold ? hold.failed : hold === null ? 1 : 0),
    result,
  });
  return NextResponse.json(result);
}
