/**
 * POST /api/cron/memory-digest-guardrail
 *
 * Standing post-ship guardrail monitor for the workspace-memory-digest
 * experiment. `task_scoped` shipped 2026-09-18 with the failure-rate
 * guardrail recorded as an accepted caveat ("ship it and watch the failure
 * rate"), and the readout cron that could have watched it was correctly
 * retired with the experiment (PR #2466) — which left the accepted arm with
 * no owner. This route is the owner.
 *
 * All arithmetic lives in `@buildd/core/memory-digest-guardrail-monitor`
 * (pure — rows in, verdict out) and the cohort queries in
 * `@buildd/core/memory-digest-readout-source` (`loadGuardrailWindowInput`),
 * for the same reason the terminal readout is split the same way: a
 * regression over the wrong cohort is invisible to a test that mocks the
 * database.
 *
 * This is deliberately NOT a re-run of the experiment. There is no control
 * arm any more — every row since the flip is `task_scoped`, `propensity: 1`
 * — so the only question a single-arm fleet can still answer is whether the
 * shipped arm is credibly worse now than it was measured to be at ship time.
 * See `memory-digest-guardrail-monitor.ts` for the full reasoning and the
 * no-terminal-signal caveat this monitor was asked to account for.
 *
 * Reporting is not gating — a breach here starts a conversation, not a
 * rollback. It notifies through `reportOps` (ops Pushover channel), which
 * carries its own atomic dedupe (`systemCache`, default 1h throttle); this
 * route also runs only once daily, so in practice it pages at most once per
 * breach-day.
 *
 * Auth: Bearer CRON_SECRET (enforced by withCronRun).
 */

import { NextRequest, NextResponse } from 'next/server';
import { evaluateMemoryDigestGuardrail } from '@buildd/core/memory-digest-guardrail-monitor';
import { loadGuardrailWindowInput } from '@buildd/core/memory-digest-readout-source';
import { READOUT_POLICY_VERSION } from '@buildd/core/memory-digest-readout';
import { reportOps } from '@buildd/core/report-ops';
import { withCronRun, type CronReport } from '@/lib/cron-run';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  return withCronRun('memory-digest-guardrail', req, report => runCronJob(report));
}

async function runCronJob(report: CronReport): Promise<NextResponse> {
  const now = new Date();
  // A little over the monitor's own rolling window, so the loader never has
  // to know the window length — it just has to cover it.
  const windowStart = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

  const { composition, sessions } = await loadGuardrailWindowInput({
    policyVersion: READOUT_POLICY_VERSION,
    windowStart,
    now,
  });

  const verdict = evaluateMemoryDigestGuardrail({ composition, sessions, now });

  if (verdict.alarm) {
    await reportOps({
      source: 'memory-digest-guardrail',
      severity: 'error',
      message: `Memory-digest guardrail breached — ${verdict.reason}`,
      detail:
        `window ${verdict.windowStart} → ${verdict.windowEnd} (${verdict.windowDays}d), ` +
        `backend ${verdict.backend}, ${verdict.sessionless} shipped-arm task(s) in window had no ` +
        `matching session and are excluded rather than counted as passing. ` +
        `See docs/design/workspace-memory-digest-arm.md for the accepted ship-time baseline.`,
      dedupeKey: 'memory-digest-guardrail',
    });
  }

  report({
    processed: verdict.n + verdict.sessionless,
    changed: verdict.alarm ? 1 : 0,
    result: verdict as unknown as Record<string, unknown>,
  });

  return NextResponse.json({ ok: true, verdict });
}
