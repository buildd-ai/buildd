import { NextRequest, NextResponse } from 'next/server';
import {
  READOUT_POLICY_VERSION,
  formatReadoutSummary,
  formatReadoutText,
} from '@buildd/core/memory-digest-readout';
import {
  claimVerdictNotification,
  persistReadout,
  runMemoryDigestReadout,
} from '@buildd/core/memory-digest-readout-source';
import { notify } from '@/lib/pushover';
import { withCronRun, type CronReport } from '@/lib/cron-run';

/**
 * Daily readout of the workspace-memory-digest experiment.
 *
 * ── Why a cron route and not a scheduled agent task ─────────────────────────
 *
 * Every number in this readout is arithmetic over rows
 * (`packages/core/memory-digest-readout.ts`), so an agent would add tokens,
 * latency and non-determinism to a computation that has exactly one right
 * answer. A cron route also gets auth, run history and a health verdict for
 * free from `withCronRun`, and — the part that matters for an experiment being
 * read by a human on a phone — the same function that answers this endpoint is
 * importable, so a page or an MCP action shows the identical figures rather
 * than a second implementation that drifts.
 *
 * ── Why this is quiet almost every day ─────────────────────────────────────
 *
 * The experiment has no end date, so there is nothing to schedule a single
 * report for. Instead the verdict is recomputed daily and notifies only when it
 * is TERMINAL: the post-boundary cohort has crossed the exposure the design
 * requires, or accrual has clearly stopped. Everything else is `accruing`,
 * which is the expected answer and gets no push at all.
 *
 * `claimVerdictNotification` makes that "once, ever" rather than "once a day":
 * it is an atomic insert that returns a row only to the first caller. Without
 * it a terminal verdict would push every morning until someone muted the
 * channel, and a muted channel is worse than no channel because it looks like
 * one.
 *
 * ── Why it reports errors on an empty cohort ────────────────────────────────
 *
 * `evaluateCronHealth` discards any run that reports neither `changed` nor
 * `errors`: a route that reports nothing buys a heartbeat row and no health
 * signal, and is unalarmable by construction. This route always reports both.
 * An `indeterminate` verdict — no rows for the policy version, or a boundary
 * that cannot be derived — reports `errors: 1`, so three consecutive runs over
 * a broken collection path alarm through cron health instead of reading as a
 * clean bill of health over an empty set.
 */

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withCronRun('memory-digest-readout', req, report => runJob(report));
}

async function runJob(report: CronReport): Promise<NextResponse> {
  const readout = await runMemoryDigestReadout({ policyVersion: READOUT_POLICY_VERSION });

  // Persisted first, and never load-bearing for the notification: the verdict
  // has to survive a push that nobody reads, and a persistence outage must not
  // be able to suppress the push.
  let persistError: string | null = null;
  try {
    await persistReadout(readout);
  } catch (err) {
    persistError = err instanceof Error ? err.message : String(err);
    console.warn('[cron:memory-digest-readout] failed to persist readout:', persistError);
  }

  let notified = false;
  let alreadyNotified = false;

  if (readout.verdict.terminal) {
    const claimed = await claimVerdictNotification(readout.verdict.notificationKey);
    if (claimed) {
      notify({
        app: 'alerts',
        // priority 0, not the module default of -1: a silent notification for
        // a terminal experiment verdict is a notification that is not read.
        priority: 0,
        title: `memory digest experiment — ${readout.verdict.status}`,
        message: formatReadoutSummary(readout),
      });
      notified = true;
    } else {
      alreadyNotified = true;
    }
  }

  report({
    processed: readout.cohortRows,
    changed: notified ? 1 : 0,
    errors: readout.verdict.indeterminate ? 1 : 0,
    result: {
      status: readout.verdict.status,
      terminal: readout.verdict.terminal,
      backend: readout.backend,
      policyVersion: readout.policyVersion,
      boundaryAt: readout.boundary?.at ?? null,
      nPerArm: readout.verdict.nPerArm,
      requiredNPerArm: readout.verdict.requiredNPerArm,
      notified,
      alreadyNotified,
      persisted: persistError === null,
    },
  });

  return NextResponse.json({
    verdict: readout.verdict,
    notified,
    alreadyNotified,
    persisted: persistError === null,
    persistError,
    readout,
    // The rendered report, so curling the endpoint by hand is the same
    // experience as running the CLI.
    text: formatReadoutText(readout),
  });
}
