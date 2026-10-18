import { describe, expect, it } from 'bun:test';
import { PR_STATE_FRESH_MS, missionPrStateStale, unseenMergeCandidates } from './mission-pr-staleness';

const NOW = Date.UTC(2026, 0, 10, 12);
const old = new Date(NOW - PR_STATE_FRESH_MS - 1_000);
const recent = new Date(NOW - 60_000);
const pr = (n: number, over: Record<string, unknown> = {}) => ({
  id: `w${n}`, prUrl: `https://github.com/example/repo/pull/${n}`, prNumber: n, mergedAt: null,
  prLifecycleStatus: 'pr_open', updatedAt: old, workspaceId: 'ws', ...over,
});

describe('missionPrStateStale (spec 3ef37387 R-12)', () => {
  it('is false when every PR is settled, just written, or there is none', () => {
    expect(missionPrStateStale([], NOW)).toBe(false);
    expect(missionPrStateStale([{ status: 'in_progress', workers: [{ id: 'w0' }] }], NOW)).toBe(false);
    expect(missionPrStateStale([
      { status: 'completed', workers: [pr(1, { mergedAt: old })] },
      { status: 'completed', workers: [pr(2, { prLifecycleStatus: 'closed' })] },
      { status: 'completed', workers: [pr(3, { prLifecycleStatus: 'merged' })] },
      { status: 'in_progress', workers: [pr(4, { updatedAt: recent })] },
    ], NOW)).toBe(false);
  });

  it('is true when a PR is open on record and its row has not moved for a while', () => {
    expect(missionPrStateStale([{ status: 'in_progress', workers: [pr(5)] }], NOW)).toBe(true);
    // Only the newest worker counts: an older worker's open PR was replaced.
    expect(missionPrStateStale([{ status: 'completed', workers: [pr(6, { mergedAt: old }), pr(7)] }], NOW)).toBe(false);
  });
});

describe('unseenMergeCandidates', () => {
  it('names completed tasks whose PR is open on record and not just written, in order', () => {
    const got = unseenMergeCandidates([
      { status: 'completed', workers: [pr(1)] },
      { status: 'in_progress', workers: [pr(2)] },
      { status: 'completed', workers: [pr(3, { mergedAt: old })] },
      { status: 'completed', workers: [pr(4, { updatedAt: recent })] },
      { status: 'completed', workers: [pr(5, { workspaceId: null })] },
    ], NOW, 'mission-ws');
    expect(got.map(w => [w.prNumber, w.workspaceId])).toEqual([[1, 'ws'], [5, 'mission-ws']]);
  });
});
