/**
 * One wrapper for every scheduled route: authenticate, run, record the run's
 * own verdict, and page someone when a job stops accomplishing anything.
 *
 * Why this exists (PR #2125): three PR sweeps ran hourly for months, each
 * returning "every row errored, nothing changed", and nothing read it. The
 * result objects were computed correctly and thrown away at the route
 * boundary. Unit tests structurally could not catch that failure — the cause
 * was a data shape that only exists in production — but a trend over a sweep's
 * own output can, within an hour of the first bad run.
 *
 * Two invariants worth stating because they are easy to break later:
 *
 *  1. **Recording is never load-bearing.** Every write and query here is
 *     wrapped so that a failure in the monitoring path cannot fail the job
 *     being monitored. A `cron_runs` outage that takes down every cron is
 *     strictly worse than having no `cron_runs` at all.
 *  2. **Nothing is recorded for an unauthenticated request.** Otherwise anyone
 *     who can reach the URL can flood the table the health check reads and bury
 *     a real signal under noise.
 *
 * Auth: a bearer token matching CRON_SECRET, and nothing else. Missing
 * CRON_SECRET → 500, mismatched token → 401. Platform-native cron headers are
 * deliberately NOT honoured: `vercel.json` declares no crons and
 * `cron-manifest.json` states the platform mechanism does not fire in this
 * project, so such a header can only ever come from a caller that is not the
 * scheduler. Two routes used to accept one; see the fix that removed it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { cronRuns } from '@buildd/core/db/schema';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { notify } from '@/lib/pushover';
import {
  evaluateCronHealth,
  HEALTH_WINDOW_MS,
  type CronRunSummary,
} from '@/lib/cron-health';

/** How long run history is kept. Long enough to see a trend, short enough not to grow. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface CronOutcome {
  /** Items the sweep looked at. */
  processed?: number;
  /**
   * Items the sweep actually changed. The load-bearing number: a job with
   * nothing to do and a job that cannot do anything both report processed=0.
   */
  changed?: number;
  /** Failures inside the sweep, as distinct from the handler throwing. */
  errors?: number;
  /** The route's own result object, kept verbatim for diagnosis. */
  result?: Record<string, unknown>;
}

export type CronReport = (outcome: CronOutcome) => void;

/**
 * Wrap a cron route handler.
 *
 * `job` is the route slug, optionally with a scope suffix
 * (`'pr-reconcile:merge-state'`) — two cadences of one route are two different
 * health signals and must not be averaged together.
 *
 * The handler receives a `report` callback. Calling it is optional: a route
 * that reports nothing still writes a heartbeat row, which proves the job ran
 * but says nothing about whether it worked, and the health check treats it
 * accordingly.
 */
export async function withCronRun(
  job: string,
  req: NextRequest,
  handler: (report: CronReport) => Promise<NextResponse>,
): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = new Date();
  let outcome: CronOutcome | null = null;
  const report: CronReport = o => { outcome = o; };

  let response: NextResponse;
  let ok = true;
  let error: string | null = null;

  try {
    response = await handler(report);
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
    console.error(`[cron:${job}] handler threw:`, err);
    // The message goes in the body, not just the log. This endpoint is gated
    // behind CRON_SECRET, and the first thing anyone does with a failing cron
    // is curl it by hand — a generic string there costs a log dig for nothing.
    response = NextResponse.json({ error }, { status: 500 });
  }

  // Everything below is best-effort by design — see invariant (1).
  await recordRun({ job, startedAt, ok, error, outcome }).catch(err =>
    console.error(`[cron:${job}] failed to record run:`, err),
  );

  return response;
}

async function recordRun(args: {
  job: string;
  startedAt: Date;
  ok: boolean;
  error: string | null;
  outcome: CronOutcome | null;
}): Promise<void> {
  const { job, startedAt, ok, error, outcome } = args;
  const finishedAt = new Date();

  const [inserted] = await db
    .insert(cronRuns)
    .values({
      job,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      ok,
      error,
      processed: outcome?.processed ?? null,
      changed: outcome?.changed ?? null,
      errors: outcome?.errors ?? null,
      result: outcome?.result ?? null,
    })
    .returning({ id: cronRuns.id });

  // Judged separately so a health-check failure cannot lose the row we just
  // wrote, which is the part that matters most.
  await checkHealth(job, inserted?.id ?? null, finishedAt).catch(err =>
    console.error(`[cron:${job}] health check failed:`, err),
  );

  await db
    .delete(cronRuns)
    .where(and(eq(cronRuns.job, job), lt(cronRuns.startedAt, new Date(Date.now() - RETENTION_MS))))
    .catch(() => {});
}

async function checkHealth(job: string, runId: string | null, now: Date): Promise<void> {
  const rows = await db.query.cronRuns.findMany({
    where: and(
      eq(cronRuns.job, job),
      gt(cronRuns.startedAt, new Date(now.getTime() - HEALTH_WINDOW_MS)),
    ),
    columns: { ok: true, errors: true, changed: true, alertedAt: true, startedAt: true },
    orderBy: desc(cronRuns.startedAt),
    limit: 50,
  });

  const verdict = evaluateCronHealth(rows as CronRunSummary[], now);
  if (!verdict.alarm) return;

  console.error(`[cron:${job}] UNHEALTHY: ${verdict.reason}`);
  notify({
    app: 'alerts',
    title: `Cron unhealthy: ${job}`,
    message: `${verdict.reason}. This job is running but accomplishing nothing.`,
    priority: 0,
  });

  // Stamp the run that fired, so the next few stay quiet rather than paging
  // hourly for as long as the job stays broken.
  if (runId) {
    await db.update(cronRuns).set({ alertedAt: now }).where(eq(cronRuns.id, runId));
  }
}
