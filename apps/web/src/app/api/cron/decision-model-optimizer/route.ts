/**
 * GET /api/cron/decision-model-optimizer
 *
 * buildd picks each decision's model for opted-in teams
 * (lib/decision-model-optimizer/optimizer.ts). Daily trigger, weekly per team:
 * first the auto-revert check over every switch in effect (database only, no
 * model call), then each opted-in team whose last scheduled comparison is a
 * week old, while the invocation's time allows; the rest go first next day.
 * No opted-in team and no switch in effect -> two cheap queries.
 *
 * `changed` = switches made plus switches reverted. The recorded result lists
 * each kind's outcome (action, reason, graded n, score vs bar), so a run that
 * switched nothing can be read from `cron_runs` without a schema change.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { runOptimizerSweep, sweepOutcomes } from '@/lib/decision-model-optimizer/optimizer';
import { dueOptimizerTeams, optimizerDeps } from '@/lib/decision-model-optimizer/store';

export const maxDuration = 300;

/** Leaves the invocation a minute to finish writing after the last call starts. */
const SWEEP_BUDGET_MS = 230_000;

export async function GET(req: NextRequest) {
  return withCronRun('decision-model-optimizer', req, async report => {
    const out = await runOptimizerSweep({ teamIds: await dueOptimizerTeams(), budgetMs: SWEEP_BUDGET_MS, trigger: 'cron' }, optimizerDeps());
    const switched = out.teams.reduce((n, t) => n + (t.status === 'ran' ? t.kinds.filter(k => k.action === 'switch').length : 0), 0);
    const errors = out.teams.filter(t => t.status === 'skipped' && t.reason.startsWith('failed')).length;
    report({
      processed: out.teams.length + out.reverts.checked,
      changed: switched + out.reverts.reverted,
      errors,
      // Per kind, so a run that switched nothing says why (cron_runs keeps this verbatim).
      result: {
        teams: out.teams.length, deferred: out.deferred.length, switched, reverted: out.reverts.reverted,
        ...(() => { const o = sweepOutcomes(out); return { outcomes: o.rows, outcomesOmitted: o.omitted }; })(),
      },
    });
    return NextResponse.json(out);
  });
}
