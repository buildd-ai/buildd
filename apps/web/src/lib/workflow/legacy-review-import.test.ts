import { describe, expect, test } from 'bun:test';
import { LIVE_LEGACY_REVIEWER_MAX_AGE_MS, SETTLING_LEGACY_VERDICT_MS, readLegacyReview, type LegacyReviewerRow } from './legacy-review-import';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const H = 'a'.repeat(40);
const at = { repoFullName: 'acme/widgets', prNumber: 7, headSha: H, baseRef: 'dev', now: NOW };
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function row(o: Partial<LegacyReviewerRow> & { ctx?: Record<string, unknown>; res?: Record<string, unknown> } = {}): LegacyReviewerRow {
  return {
    id: o.id ?? 'r1',
    status: o.status ?? 'completed',
    created_at: o.created_at ?? ago(60_000),
    updated_at: o.updated_at ?? ago(30_000),
    context: { prNumber: 7, repoFullName: 'Acme/Widgets', headSha: H, baseRef: 'dev', ...o.ctx },
    result: {
      structuredOutput: { verdict: 'approve', confidence: 0.9, findings: [{ path: 'a.ts', title: 'nit', required: false }] },
      evidenceSha: H, settledVerdict: 'approve', ...o.res,
    },
  };
}

describe('readLegacyReview (968aebfd)', () => {
  test('a settled verdict at the head and base is adopted with its findings and the gated verdict', () => {
    const r = readLegacyReview([row({ res: { settledVerdict: 'escalate' } })], at);
    expect(r).toMatchObject({ kind: 'adopt', reviewerTaskId: 'r1', verdict: 'approve', effectiveVerdict: 'escalate', confidence: 0.9, evidenceSha: H });
    expect((r as { output: { findings: unknown[] } }).output.findings).toHaveLength(1);
  });

  test('another head, PR, repo or a kernel round\'s reviewer is not this head\'s review', () => {
    expect(readLegacyReview([row({ ctx: { headSha: 'b'.repeat(40) } })], at)).toEqual({ kind: 'none', reason: 'no_review_at_head' });
    expect(readLegacyReview([row({ ctx: { prNumber: 8 } })], at).kind).toBe('none');
    expect(readLegacyReview([row({ ctx: { repoFullName: 'acme/other' } })], at).kind).toBe('none');
    expect(readLegacyReview([row({ ctx: { workflowRoundId: 'round' } })], at).kind).toBe('none');
  });

  test('stale or invalid evidence is not adopted', () => {
    expect(readLegacyReview([row({ res: { evidenceSha: 'c'.repeat(40) } })], at)).toMatchObject({ kind: 'none', reason: 'evidence_not_at_head' });
    expect(readLegacyReview([row({ res: { evidenceSha: null } })], at)).toMatchObject({ kind: 'none', reason: 'evidence_not_at_head' });
    expect(readLegacyReview([row({ ctx: { baseRef: 'main' } })], at)).toMatchObject({ kind: 'none', reason: 'base_not_reviewed' });
    expect(readLegacyReview([row({ ctx: { baseRef: undefined } })], at)).toMatchObject({ kind: 'none', reason: 'base_not_reviewed' });
    expect(readLegacyReview([row()], { ...at, baseRef: null })).toMatchObject({ kind: 'none', reason: 'base_not_reviewed' });
    expect(readLegacyReview([row({ ctx: { compositionDelta: { novelDeltaPaths: ['a.ts'] } } })], at)).toMatchObject({ kind: 'none', reason: 'scoped_review' });
    expect(readLegacyReview([row({ res: { structuredOutput: { verdict: 'maybe' } } })], at)).toMatchObject({ kind: 'none', reason: 'verdict_not_settled' });
    expect(readLegacyReview([row({ status: 'failed' })], at)).toMatchObject({ kind: 'none', reason: 'reviewer_failed' });
  });

  test('a verdict whose gates have not settled is waited for briefly, then never adopted (a row from before the marker)', () => {
    expect(readLegacyReview([row({ res: { settledVerdict: undefined }, updated_at: ago(60_000) })], at)).toEqual({ kind: 'live', reviewerTaskId: 'r1' });
    expect(readLegacyReview([row({ res: { settledVerdict: undefined }, updated_at: ago(SETTLING_LEGACY_VERDICT_MS + 1) })], at)).toMatchObject({ kind: 'none', reason: 'verdict_not_settled' });
  });

  test('a running reviewer at the head is waited for, unless it has run too long', () => {
    expect(readLegacyReview([row({ status: 'in_progress', created_at: ago(60_000) })], at)).toEqual({ kind: 'live', reviewerTaskId: 'r1' });
    expect(readLegacyReview([row({ status: 'pending', created_at: ago(LIVE_LEGACY_REVIEWER_MAX_AGE_MS + 1) })], at)).toMatchObject({ kind: 'none', reason: 'reviewer_stalled' });
  });

  test('the newest reviewer at the head decides: a re-review asked for after a verdict stands in for it', () => {
    const older = row({ id: 'old' });
    expect(readLegacyReview([row({ id: 'new', status: 'in_progress' }), older], at)).toEqual({ kind: 'live', reviewerTaskId: 'new' });
    expect(readLegacyReview([row({ id: 'new', res: { evidenceSha: null } }), older], at)).toMatchObject({ kind: 'none', reviewerTaskId: 'new' });
    // A newer reviewer of an earlier head says nothing about this one.
    expect(readLegacyReview([row({ id: 'prior', ctx: { headSha: 'd'.repeat(40) } }), older], at)).toMatchObject({ kind: 'adopt', reviewerTaskId: 'old' });
  });
});
