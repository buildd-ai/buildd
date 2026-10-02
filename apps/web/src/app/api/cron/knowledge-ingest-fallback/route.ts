/**
 * GET /api/cron/knowledge-ingest-fallback
 *
 * Serverless fallback for `full`-scope knowledge ingest jobs that no runner
 * will take (see apps/web/src/lib/knowledge-full-ingest-fallback.ts). Each tick
 * continues the job the fallback is already running, then takes stalled
 * queued jobs, reading the repo through the GitHub API, until its time budget
 * is spent; a job larger than one tick resumes from its cursor next tick.
 *
 * `changed` = jobs completed this tick; `errors` = jobs whose slice failed
 * (retried next tick, parked after repeated failures). Nothing stalled -> one
 * cheap query.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun). Triggered by cron-manifest.json.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { defaultFallbackDeps, runFullIngestFallbackTick } from '@/lib/knowledge-full-ingest-fallback';

// The tick budget (FALLBACK_TICK_BUDGET_MS) leaves headroom under this.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  return withCronRun('knowledge-ingest-fallback', req, async report => {
    const result = await runFullIngestFallbackTick(await defaultFallbackDeps());
    report({
      processed: result.considered,
      changed: result.completed.length,
      errors: result.errors.length,
      result: { ...result },
    });
    return NextResponse.json({ ok: true, ...result });
  });
}
