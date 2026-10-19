import { describe, expect, test } from 'bun:test';
import type { PrReviewStatus } from '@/lib/pr-review-status';
import { candidateReviewOf, openPrReviewReads, unownedReviewOf } from './open-pr-review';

const SHA = 'c'.repeat(40);
const status = (o: Partial<PrReviewStatus>): PrReviewStatus => ({ state: 'not_requested', merged: false, reviewTaskId: null, reviewHeadSha: null, feedback: null, summary: null, escalationReason: null, ...o } as PrReviewStatus);
const run = (name: string, conclusion: string | null, sha = SHA, st = 'completed') => ({ name, head_sha: sha, status: st, conclusion, completed_at: '2026-01-01T00:00:00Z' });

function reads(runs: unknown[], s: PrReviewStatus) {
  return openPrReviewReads({
    api: async (_i, path) => (String(path).includes('/check-runs') ? { total_count: runs.length, check_runs: runs } : { total_count: 0, workflow_runs: [] }),
    read: async () => s,
  });
}
const p = { workspaceId: 'ws', installationId: 1, repoFullName: 'acme/app', prNumber: 9, sha: SHA };

describe('the review reads behind an open PR\'s status', () => {
  test('nobody asked is "not requested"; any review state past that is in progress', () => {
    expect(unownedReviewOf('not_requested')).toBe('not_requested');
    for (const s of ['queued', 'reviewing', 'approved', 'escalated', 'review_failed'] as const) expect(unownedReviewOf(s)).toBe('in_progress');
    expect(unownedReviewOf('changes_requested')).toBe('changes_requested');
  });

  test('the review verdict gate at the candidate SHA', () => {
    expect(candidateReviewOf(status({ state: 'not_requested' }), SHA)).toEqual({ verdict: 'pass' });
    expect(candidateReviewOf(status({ state: 'approved', reviewHeadSha: SHA }), SHA)).toEqual({ verdict: 'pass' });
    expect(candidateReviewOf(status({ state: 'changes_requested', reviewHeadSha: SHA, feedback: 'fix it' }), SHA).verdict).toBe('changes_requested');
    expect(candidateReviewOf(status({ state: 'escalated', reviewHeadSha: SHA }), SHA).verdict).toBe('blocked');
    expect(candidateReviewOf(status({ state: 'reviewing', reviewHeadSha: SHA }), SHA).verdict).toBe('pending');
    // Approved at an earlier SHA: waits for the re-review, never passes.
    expect(candidateReviewOf(status({ state: 'approved', reviewHeadSha: 'd'.repeat(40) }), SHA).verdict).toBe('pending');
  });

  test('each required candidate check on the candidate SHA only; a run on another SHA is missing', async () => {
    const r = await reads([run('build', 'success'), run('release candidate verified', 'success', 'e'.repeat(40))], status({})).candidate(p);
    expect(Object.fromEntries(r.checks.map((c) => [c.name, c.state]))).toMatchObject({ build: 'passing', 'release candidate verified': 'missing' });
  });

  test('a failed and a running check', async () => {
    const r = await reads([run('build', 'failure'), run('release candidate verified', null, SHA, 'in_progress')], status({})).candidate(p);
    expect(Object.fromEntries(r.checks.map((c) => [c.name, c.state]))).toMatchObject({ build: 'failing', 'release candidate verified': 'pending' });
  });
});
