/**
 * Rounds per merged PR by trigger (58c8961e): the pure aggregation, and the
 * read that degrades to null instead of throwing.
 */
import { describe, expect, it, mock } from 'bun:test';

let rows: Record<string, unknown>[] = [];
let throws = false;
mock.module('@buildd/core/db', () => ({
  db: { execute: async () => { if (throws) throw new Error('db down'); return { rows }; } },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { computeReviewRoundMetrics, getReviewRoundMetrics, reviewRoundsOfMergedSql, type ReviewRoundRow } from './review-round-metrics';

const R = (o: Partial<ReviewRoundRow>): ReviewRoundRow => ({ deliveryId: 'd1', trigger: 'first_pass', kind: 'full', status: 'decided', endReason: null, deltaApproval: false, ...o });

describe('computeReviewRoundMetrics', () => {
  it('counts rounds per merged PR, split by trigger, with unrecorded rounds kept apart', () => {
    const m = computeReviewRoundMetrics([
      R({ deliveryId: 'd1', trigger: 'first_pass' }),
      R({ deliveryId: 'd1', trigger: 'ci_fix', kind: 'delta', deltaApproval: true }),
      R({ deliveryId: 'd2', trigger: 'first_pass', status: 'superseded', endReason: 'superseded_by_push' }),
      R({ deliveryId: 'd2', trigger: 'superseded_by_push' }),
      R({ deliveryId: 'd3', trigger: null }),
    ], '7d');
    expect(m).toMatchObject({ window: '7d', mergedPrs: 3, rounds: 5, roundsPerMergedPr: 1.67, deltaApprovalRounds: 1, supersededRounds: 1, supersededWithoutReason: 0, truncated: false });
    expect(m.byTrigger).toEqual([
      { trigger: 'first_pass', rounds: 2, perMergedPr: 0.67 },
      { trigger: 'ci_fix', rounds: 1, perMergedPr: 0.33 },
      { trigger: 'superseded_by_push', rounds: 1, perMergedPr: 0.33 },
      { trigger: 'unrecorded', rounds: 1, perMergedPr: 0.33 },
    ]);
  });
  it('flags a superseded round that recorded no reason', () => {
    expect(computeReviewRoundMetrics([R({ status: 'superseded' })], '24h').supersededWithoutReason).toBe(1);
  });
  it('no merged PRs: zeros, not NaN', () => {
    expect(computeReviewRoundMetrics([], '30d')).toMatchObject({ mergedPrs: 0, rounds: 0, roundsPerMergedPr: 0, byTrigger: [] });
  });
});

describe('getReviewRoundMetrics', () => {
  it('reads merged deliveries in scope and maps the rows', async () => {
    rows = [{ delivery_id: 'd1', trigger: 'ci_fix', kind: 'delta', status: 'decided', end_reason: null, delta_approval: true }];
    throws = false;
    expect(await getReviewRoundMetrics(['ws-1'], '7d')).toMatchObject({ mergedPrs: 1, deltaApprovalRounds: 1 });
  });
  it('an empty scope or a failed read is null', async () => {
    expect(await getReviewRoundMetrics([], '7d')).toBeNull();
    throws = true;
    expect(await getReviewRoundMetrics(['ws-1'], '7d')).toBeNull();
    throws = false;
  });
  it('the query renders through PgDialect and reads only merged deliveries of the given workspaces', () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(reviewRoundsOfMergedSql(['ws-1'], new Date('2026-01-01T00:00:00Z')));
    expect(text).toContain("d.state = 'MERGED'");
    expect(text).toContain('d.workspace_id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)');
    expect(text).toContain("r.scope->>'trigger' AS trigger");
    expect(params).toEqual(['["ws-1"]', '2026-01-01T00:00:00.000Z', 20000]);
  });
});
