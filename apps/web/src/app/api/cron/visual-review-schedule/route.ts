/**
 * POST /api/cron/visual-review-schedule
 *
 * The automatic half of the mission visual review: files the review when the
 * mission's integration branch owes one, re-files it on a new UI-impacting
 * head, retries system failures with backoff, and leaves a blocked mission
 * with a named next actor. All of the judgement is in
 * `lib/workflow/visual-review-schedule.ts` (pure); this is the trigger.
 *
 * A healthy fleet costs the missions query and, per mission with an integration
 * PR, the reads the state loader already makes. Nothing is filed twice:
 * `requestMissionSurfaceAudit` returns the live audit instead.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { sweepVisualReviewSchedule } from '@/lib/workflow/visual-review-schedule-run';

export const maxDuration = 60;

async function run(req: NextRequest) {
  return withCronRun('visual-review-schedule', req, async report => {
    const outcomes = await sweepVisualReviewSchedule();
    const changed = outcomes.filter(o => o.plan.action === 'enqueue' || o.plan.action === 'restamp').length;
    const blocked = outcomes.filter(o => o.plan.action === 'blocked');
    report({
      processed: outcomes.length,
      changed,
      errors: 0,
      result: {
        blocked: blocked.map(o => ({ mission: o.missionId.slice(0, 8), plan: o.plan })),
        actions: outcomes.reduce<Record<string, number>>((m, o) => ({ ...m, [o.plan.action]: (m[o.plan.action] ?? 0) + 1 }), {}),
      },
    });
    return NextResponse.json({ processed: outcomes.length, changed, blocked: blocked.length });
  });
}

export const POST = run;
export const GET = run;
