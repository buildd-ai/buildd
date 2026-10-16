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
 * - Every run, each unfrozen `dial` cell is evaluated
 *   (packages/core/tier-dial.ts; chat cells via tier-dial-chat.ts on thumbs
 *   and chat retro verdicts): learning cells may be promoted, shifted cells
 *   reverted when their own runs slip. Hourly so a revert lands within
 *   the hour; a run with nothing to change writes no change row.
 *
 * - Every run also evaluates claim coordination learning cells, recording
 *   their safety evidence, policy changes and reasons through the same dial.
 *
 * `changed` includes pool allocations and both model and claim dial changes.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { TIER_POOLS_JOB, runTierPoolsDaily } from '@buildd/core/tier-pool-daily-source';
import { runClaimLearningStep } from '@buildd/core/orchestration-claim-learning-source';
import { runDialStep } from '@buildd/core/tier-dial-source';
import { withCronRun } from '@/lib/cron-run';
// Chat retro verdicts for chat dial cells (experiment; lib/chat-retro/REMOVAL.md).
import { chatRetroQualitySource } from '@/lib/chat-retro/policy-signal';

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  return withCronRun(TIER_POOLS_JOB, req, async report => {
    const now = new Date();
    const summary = await runTierPoolsDaily({ now });
    const dial = await runDialStep({ now, chatQuality: chatRetroQualitySource });
    // Claim cells reuse this hourly evaluation job and the existing dial mechanism.
    // A failed evidence read changes no claim policy and remains visible in the cron verdict.
    let claimReadErrors = 0;
    const claimLearning = await runClaimLearningStep({ now }).catch(error => {
      claimReadErrors++;
      console.error('[tier-pools] claim learning evaluation failed', error instanceof Error ? error.message : error);
      return null;
    });
    const claimCells = claimLearning?.cells ?? [];
    const result = { ...summary, dial, claimLearning };
    report({
      processed: summary.pools + dial.pools + claimCells.length,
      changed: summary.written + dial.transitions.length + claimCells.filter(cell => cell.changed).length,
      errors: summary.errors + dial.errors + claimReadErrors + claimCells.filter(cell => !cell.applied).length,
      result: result as unknown as Record<string, unknown>,
    });
    return NextResponse.json(result);
  });
}
