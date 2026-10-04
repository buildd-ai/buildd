/**
 * GET /api/cron/prompt-evals
 *
 * The weekly prompt eval (apps/web/src/lib/prompt-evals/run.ts): scores the
 * decision prompts in the private prompts repo, at the ref the deploy seed
 * reads, against the labelled cases kept beside them. The operator team's key
 * pays. Results land in prompt_eval_runs / prompt_eval_results (ids,
 * fingerprints, model and scores; never text) and are read at
 * GET /api/admin/prompt-evals.
 *
 * `processed` = cases scored, `changed` = result rows written, `errors` =
 * failed calls plus cases the time budget left unrun. No PROMPTS_REPO, or
 * another eval in flight -> a skipped no-op.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun). Triggered by cron-manifest.json.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { runPromptEval } from '@/lib/prompt-evals/run';
import { promptEvalDeps } from '@/lib/prompt-evals/store';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  return withCronRun('prompt-evals', req, async report => {
    const out = await runPromptEval({ trigger: 'cron' }, promptEvalDeps());
    if (out.status === 'skipped') {
      report({ processed: 0, changed: 0, errors: 0, result: { status: out.status, reason: out.reason } });
      return NextResponse.json({ ok: true, ...out });
    }
    const sets = out.report?.sets ?? [];
    report({
      processed: sets.reduce((n, s) => n + (s.status === 'scored' ? s.cases - s.notRun : 0), 0),
      changed: out.status === 'refused' ? 0 : sets.length,
      errors: sets.reduce((n, s) => n + s.errors + s.notRun, 0) + (out.status === 'passed' ? 0 : 1),
      result: { status: out.status, runId: out.runId, evalModel: out.evalModel, prodModel: out.prodModel, modelMismatch: out.modelMismatch, problems: out.problems },
    });
    return NextResponse.json({ ok: out.status === 'passed', status: out.status, runId: out.runId, modelMismatch: out.modelMismatch, problems: out.problems });
  });
}
