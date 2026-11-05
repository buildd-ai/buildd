import { describe, expect, it, mock } from 'bun:test';

// Spec b7fc9316 R-33, AC-34: Review all filtered to a tier lists, and so
// approves, only that tier; each row keeps its own signed request.
const row = (n: number, tier: 'high' | 'medium' | 'low') => ({
  specId: `s${n}`, title: `Spec ${n}`, workspaceId: 'w', workspaceName: 'Shop', headRevision: 2, approvedRevision: 1, version: 3,
  contentHash: `h${n}`, author: 'an agent', changeSummary: null, explanationSummary: `Summary ${n}`, proposedAt: '2026-11-05T00:00:00.000Z', tier, tierReasons: ['why'],
});
const all = [row(1, 'high'), row(2, 'medium'), row(3, 'high'), row(4, 'low')];

mock.module('./approval-inbox', () => ({ listAwaitingApproval: async () => all }));
mock.module('./approval-request', () => ({ signSpecApprovalRequest: (p: { specId: string }) => `signed-${p.specId}` }));
mock.module('./diff', () => ({ diffSpecHunks: () => ({ hunks: [], omittedLines: 0 }), diffSpecRevisions: async () => ({ ok: false }) }));
mock.module('./store', () => ({ getSpec: async () => ({ ok: false }) }));

const { reviewAllView } = await import('./review-all-view');

describe('reviewAllView tier filter', () => {
  it('lists every tier by default and counts each', async () => {
    const v = await reviewAllView('u1');
    expect(v.rows.map((r) => r.specId)).toEqual(['s1', 's2', 's3', 's4']);
    expect(v.counts).toEqual({ high: 2, medium: 1, low: 1 });
  });
  it('filtered to high, lists only high rows, each with its own signed request; counts still cover all', async () => {
    const v = await reviewAllView('u1', 'high');
    expect(v.rows.map((r) => [r.specId, r.tier, r.request])).toEqual([['s1', 'high', 'signed-s1'], ['s3', 'high', 'signed-s3']]);
    expect(v.counts).toEqual({ high: 2, medium: 1, low: 1 });
  });
});
