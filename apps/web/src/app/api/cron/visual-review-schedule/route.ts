/**
 * POST /api/cron/visual-review-schedule
 *
 * The automatic half of the mission visual review: files the review when the
 * mission's integration branch owes one, re-files it on a new UI-impacting
 * head, retries system failures with backoff, and leaves a blocked mission
 * with a named next actor. All of the judgement is in
 * `lib/workflow/visual-review-schedule.ts` (pure); this is the trigger.
 *
 * Cost (spec 3ef37387 R-25): a bounded batch of missions per run, their facts
 * read once for the batch, and the review itself read only for a mission whose
 * plan depends on it. The batch rotates: each run starts after the last mission
 * the previous run took (its `cursor`, kept in the run's own recorded result).
 * Nothing is filed twice: `requestMissionSurfaceAudit` returns the live audit instead.
 *
 * First it re-queues any audit that failed only because build work it depends
 * on failed, once that work has completed (`sweepChecksFailedByRecoveredDeps`,
 * spec 072de598 I-14), so the plan below sees it queued.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { cronRuns } from '@buildd/core/db/schema';
import { withCronRun } from '@/lib/cron-run';
import { sweepVisualReviewSchedule } from '@/lib/workflow/visual-review-schedule-run';
import { sweepChecksFailedByRecoveredDeps } from '@/lib/task-dependencies';

const JOB = 'visual-review-schedule';

/** Where the previous recorded run stopped. Best effort: none means start from the beginning. */
async function previousCursor(): Promise<string | null> {
  try {
    const [prev] = await db
      .select({ result: cronRuns.result })
      .from(cronRuns)
      .where(and(eq(cronRuns.job, JOB), eq(cronRuns.ok, true)))
      .orderBy(desc(cronRuns.startedAt))
      .limit(1);
    const cursor = (prev?.result as { cursor?: unknown } | null)?.cursor;
    return typeof cursor === 'string' ? cursor : null;
  } catch {
    return null;
  }
}

export const maxDuration = 60;

async function run(req: NextRequest) {
  return withCronRun(JOB, req, async report => {
    const reopened = await sweepChecksFailedByRecoveredDeps().catch(err => {
      console.error('[visual-review-schedule] reopening audits failed by a recovered dependency:', err);
      return 0;
    });
    const { outcomes, cursor } = await sweepVisualReviewSchedule(Date.now(), 50, { after: await previousCursor() });
    const changed = outcomes.filter(o => o.plan.action === 'enqueue' || o.plan.action === 'restamp').length;
    const blocked = outcomes.filter(o => o.plan.action === 'blocked');
    report({
      processed: outcomes.length,
      changed,
      errors: 0,
      result: {
        reopened,
        cursor,
        blocked: blocked.map(o => ({ mission: o.missionId.slice(0, 8), plan: o.plan })),
        actions: outcomes.reduce<Record<string, number>>((m, o) => ({ ...m, [o.plan.action]: (m[o.plan.action] ?? 0) + 1 }), {}),
      },
    });
    return NextResponse.json({ processed: outcomes.length, changed, blocked: blocked.length });
  });
}

export const POST = run;
export const GET = run;
