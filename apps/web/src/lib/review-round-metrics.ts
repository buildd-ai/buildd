/**
 * Review rounds per merged PR, split by why each round started (58c8961e).
 *
 * Read from the kernel's own `workflow_review_rounds` (the trigger lives in the
 * round's `scope`, see lib/workflow/kernel.ts `ROUND_TRIGGER_KEY`), over the
 * deliveries that merged in the window. A round recorded before rounds carried
 * a trigger counts under `unrecorded`, never under a guessed reason. Also says
 * how many rounds were delta reviews carrying an approval, how many a push
 * superseded, and how many ended with no verdict and no recorded reason (the
 * number that should stay at zero).
 *
 * Aggregation is pure and exported for tests; `getReviewRoundMetrics` is the
 * only DB read and never throws: a broken read degrades to null (omitted).
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { gateWindowStartFor } from '@buildd/core/gate-analytics';
import type { GateWindow, ReviewRoundMetrics } from '@buildd/shared';

const MAX_ROUND_ROWS = 20_000;

export interface ReviewRoundRow {
  deliveryId: string;
  trigger: string | null;
  kind: string;
  status: string;
  endReason: string | null;
  deltaApproval: boolean;
}

export function reviewRoundsOfMergedSql(workspaceIds: string[], since: Date): SQL {
  return sql`-- review_round_metrics
SELECT r.delivery_id, r.scope->>'trigger' AS trigger, r.kind, r.status, r.scope->>'endReason' AS end_reason,
  COALESCE(r.scope->'deltaApproval'->>'eligible', 'false') = 'true' AS delta_approval
FROM workflow_review_rounds r
JOIN workflow_deliveries d ON d.id = r.delivery_id
WHERE d.workspace_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(workspaceIds)}::jsonb)::uuid)
  AND d.state = 'MERGED' AND d.merged_at >= ${since.toISOString()}::timestamptz
ORDER BY d.merged_at DESC, r.round
LIMIT ${MAX_ROUND_ROWS}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeReviewRoundMetrics(rows: ReviewRoundRow[], window: GateWindow): ReviewRoundMetrics {
  const merged = new Set(rows.map((r) => r.deliveryId)).size;
  const counts = new Map<string, number>();
  let deltaApproval = 0;
  let superseded = 0;
  let endedWithoutReason = 0;
  for (const r of rows) {
    const t = r.trigger ?? 'unrecorded';
    counts.set(t, (counts.get(t) ?? 0) + 1);
    if (r.deltaApproval && r.kind === 'delta') deltaApproval++;
    if (r.status === 'superseded') {
      superseded++;
      if (!r.endReason && r.trigger) endedWithoutReason++;
    }
  }
  const byTrigger = [...counts.entries()]
    .map(([trigger, n]) => ({ trigger, rounds: n, perMergedPr: merged ? round2(n / merged) : 0 }))
    .sort((a, b) => b.rounds - a.rounds || a.trigger.localeCompare(b.trigger));
  return {
    window,
    mergedPrs: merged,
    rounds: rows.length,
    roundsPerMergedPr: merged ? round2(rows.length / merged) : 0,
    byTrigger,
    deltaApprovalRounds: deltaApproval,
    supersededRounds: superseded,
    supersededWithoutReason: endedWithoutReason,
    truncated: rows.length >= MAX_ROUND_ROWS,
  };
}

const toRow = (r: Record<string, unknown>): ReviewRoundRow => ({
  deliveryId: String(r.delivery_id),
  trigger: typeof r.trigger === 'string' ? r.trigger : null,
  kind: String(r.kind),
  status: String(r.status),
  endReason: typeof r.end_reason === 'string' ? r.end_reason : null,
  deltaApproval: r.delta_approval === true,
});

export async function getReviewRoundMetrics(
  scopedWsIds: string[],
  window: GateWindow = '7d',
  now: Date = new Date(),
): Promise<ReviewRoundMetrics | null> {
  if (scopedWsIds.length === 0) return null;
  try {
    const res = (await db.execute(reviewRoundsOfMergedSql(scopedWsIds, gateWindowStartFor(window, now)))) as unknown as { rows?: Record<string, unknown>[] };
    return computeReviewRoundMetrics((res.rows ?? []).map(toRow), window);
  } catch (err) {
    console.error('[review-round-metrics] read failed:', err);
    return null;
  }
}
