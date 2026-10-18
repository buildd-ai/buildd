/**
 * GET /api/cron/mission-summaries
 *
 * The stored mission summary's reconcile (spec 3ef37387 "The shape";
 * lib/mission-summary-store.ts): recompute a bounded sample of missions,
 * missing and oldest `computed_at` first, write what differs, and count it.
 * It is the floor under `refreshMissionSummary` (which runs at most once per
 * write, after the response) and the backfill: a mission never summarised is
 * missing, so it comes first.
 *
 * `?limit=N` (1 to 200, default 50) sizes the pass; call it repeatedly to
 * backfill faster. `processed` = missions checked; `changed` = summaries that
 * were missing, of another version, or differed; `result.missedWrites` = those
 * that differed even computed at their own `computed_at`, i.e. a write that
 * never refreshed its mission.
 *
 * Auth: Bearer CRON_SECRET (via withCronRun). Triggered by cron-manifest.json.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cron-run';
import { reconcileMissionSummaries } from '@/lib/mission-summary-store';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withCronRun('mission-summaries', req, async report => {
    const raw = Number(req.nextUrl.searchParams.get('limit'));
    const result = await reconcileMissionSummaries(Number.isFinite(raw) && raw > 0 ? { limit: raw } : {});
    report({
      processed: result.checked,
      changed: result.missing + result.otherVersion + result.repaired,
      errors: 0,
      result: { ...result },
    });
    return NextResponse.json({ ok: true, ...result });
  });
}
