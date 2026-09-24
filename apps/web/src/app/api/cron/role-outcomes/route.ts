/**
 * GET /api/cron/role-outcomes
 *
 * Records, once an hour, each role's terminal outcomes over the last hour
 * against the day before it, plus the runner builds on live heartbeats and the
 * web deploy that ran the job. Read-only; it judges nothing and notifies
 * nobody.
 *
 * ── Why a cron that only records ────────────────────────────────────────────
 * Its sole consumer is the out-of-band responder's `role-regression` detector
 * (`apps/responder/src/detectors/role-regression.ts`), whose only production
 * access is a read-only role on `cron_runs`. The detector owns the thresholds
 * and the page, and it has to be able to page when this platform is what
 * broke — so the platform supplies counts and the watcher supplies judgement.
 * The feed contract is `packages/core/role-outcomes-feed.ts`.
 *
 * ── Polarity ────────────────────────────────────────────────────────────────
 * `changed` = role buckets recorded: work done, not problems found. Declared
 * `work` in `CRON_JOB_REGISTRY` so nobody later reads a quiet night (zero
 * buckets) as a findings-style all-clear or a busy hour as an alarm.
 *
 * ── Cadence ─────────────────────────────────────────────────────────────────
 * Hourly, all 24 hours, on the hour — the recent window is exactly one hour,
 * so consecutive runs tile with no gap, and the incident this feeds ran through
 * the night. Two aggregates and no network, the same cost profile as the
 * fleet-idle pass that shares its :00 Neon wake window.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */

import { NextRequest, NextResponse } from 'next/server';
import { ROLE_OUTCOMES_JOB } from '@buildd/core/role-outcomes-feed';
import { withCronRun } from '@/lib/cron-run';
import { computeRoleOutcomes } from '@/lib/role-outcomes';
import { scanRoleOutcomes } from '@/lib/role-outcomes-scan';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withCronRun(ROLE_OUTCOMES_JOB, req, async report => {
    const now = new Date();
    const scan = await scanRoleOutcomes(now);
    const result = computeRoleOutcomes({
      now,
      workers: scan.workers,
      heartbeats: scan.heartbeats,
      truncated: scan.truncated,
      appCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    });
    report({
      processed: result.rowsScanned,
      changed: result.roles.length,
      errors: 0,
      result: result as unknown as Record<string, unknown>,
    });
    return NextResponse.json(result);
  });
}
