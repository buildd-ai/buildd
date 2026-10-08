/**
 * GET /api/cron/post-session-quality
 *
 * One bounded pass of the post-session quality loop
 * (apps/web/src/lib/post-session-loop.ts): collect and triage recently
 * terminal workers, then analyse the selected runs, record findings and apply
 * the action policy under each workspace's mode (off / shadow / propose,
 * absent ⇒ shadow).
 *
 * Out of band: task completion, PR review, merge and release never wait on
 * this route, and a failure here touches none of them. Each worker attempt is
 * processed once per policy version (the run ledger is the dedupe), so an
 * overlapping or repeated trigger does no double work. Starting new work stops
 * after a time budget; what is left is reported as `deferred` and taken by the
 * next pass.
 *
 * `changed` = runs advanced a stage this pass (collected, triaged, analysed) —
 * work performed, not problems found. Findings that need a person become
 * follow-up tasks under `propose`, not alerts from here.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { POST_SESSION_LOOP_BUDGET_MS, runPostSessionQualityLoop } from '@/lib/post-session-loop';

export const maxDuration = 60;

const POST_SESSION_QUALITY_JOB = 'post-session-quality';

export async function GET(req: NextRequest) {
  return withCronRun(POST_SESSION_QUALITY_JOB, req, async report => {
    const readout = await runPostSessionQualityLoop({ budgetMs: POST_SESSION_LOOP_BUDGET_MS });
    const f = readout.stageFailures;
    const errors = f.collect + f.triage + f.analyse + f.act;
    console.log(JSON.stringify({ event: 'post_session_quality', ...readout }));
    report({
      processed: readout.evaluated + readout.triaged + readout.analysed + readout.deferred,
      changed: readout.evaluated + readout.triaged + readout.analysed,
      errors,
      result: readout as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ ok: true, readout });
  });
}
