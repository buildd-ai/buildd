/**
 * GET /api/cron/tier-pools
 *
 * The daily step for tier model pools (knowledge-base: buildd/design/tier-weights.md §3c, §4).
 * Hourly at :00; the work inside is once per day:
 *
 * - After 03:00 UTC, each team with an explore pool fetches its OpenRouter
 *   rankings once, on its own key (at most three requests, no retry).
 * - After 06:00 UTC, each unfrozen split or explore pool runs its step once.
 *   Split pools accept only a harm cut or an expired model. Explore pools run
 *   the seeded Thompson step with popularity, succession and expiry.
 *
 * Every change is a compare-and-set allocation write with its own
 * `tier_pool_changes` row and a `system:*` actor. A second run on the same
 * day writes nothing.
 *
 * `changed` = pools whose allocation this run changed: work done.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { TIER_POOLS_JOB, runTierPoolsDaily } from '@buildd/core/tier-pool-daily-source';
import { withCronRun } from '@/lib/cron-run';

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  return withCronRun(TIER_POOLS_JOB, req, async report => {
    const summary = await runTierPoolsDaily({ now: new Date() });
    report({
      processed: summary.pools,
      changed: summary.written,
      errors: summary.errors,
      result: summary as unknown as Record<string, unknown>,
    });
    return NextResponse.json(summary);
  });
}
