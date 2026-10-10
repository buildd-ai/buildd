/**
 * POST /api/cron/failure-pattern-sentinel
 *
 * The 30-minute backstop for the Failure Pattern Sentinel. The same
 * `runFailurePatternSweep` also runs after individual lifecycle transitions
 * (`failure-pattern-sentinel-trigger.ts`, deferred and debounced so it never
 * blocks the request that observed the transition) — this route is what
 * guarantees every workspace gets evaluated even when no transition fires it,
 * or a triggered sweep was lost/suppressed. Idempotent through the incident
 * store's own upsert, so a triggered sweep and this backstop landing on the
 * same window is a no-op, not a duplicate.
 *
 * `changed` = incidents opened or updated this run — a detector job, so a
 * nonzero count means "found a systemic pattern", not "did work" (see
 * `CRON_JOB_REGISTRY` below). A quiet fleet costs the window queries and
 * nothing else.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { runFailurePatternSweep, productionSweepDeps } from '@/lib/failure-pattern-sweep';

export const maxDuration = 60;

const JOB = 'failure-pattern-sentinel';

export async function POST(req: NextRequest) {
  return withCronRun(JOB, req, async report => {
    const counters = await runFailurePatternSweep(productionSweepDeps());
    console.log(JSON.stringify({ event: 'failure_pattern_sentinel_backstop', ...counters }));
    report({
      processed: counters.workspacesEvaluated,
      changed: counters.incidentsOpened + counters.incidentsUpdated,
      errors: counters.runFailures,
      result: { ...counters },
    });
    return NextResponse.json({ ok: true, ...counters });
  });
}
