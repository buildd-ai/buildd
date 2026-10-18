import { beforeEach, expect, it, mock } from 'bun:test';

/** The mission page already holds the waiver and the visual-review model: the state load reuses them. */
mock.module('server-only', () => ({}));
mock.module('@buildd/core/db', () => ({ db: { query: {
  missions: { findFirst: async () => ({ id: 'm1', status: 'active', workspaceId: 'ws', autoSurfaceAudit: true, workingBranch: null, primaryPrNumber: null }) },
  workspaces: { findFirst: async () => ({ gitConfig: null, githubRepoId: null }) },
  tasks: { findMany: async () => [] },
} } }));
const loadSurfaceAuditWaiver = mock(async () => null);
const evaluateSurfaceAuditGate = mock(async (..._a: any[]) => ({ required: false, why: 'no_ui_change' }));
mock.module('@/lib/mission-surface-audit-gate', () => ({
  loadSurfaceAuditWaiver,
  evaluateSurfaceAuditGate,
  loadSurfaceAuditGateTasks: async () => [],
}));
const loadVisualReview = mock(async () => ({ audit: null }) as any);
mock.module('@/lib/visual-review-load', () => ({ loadVisualReview }));
mock.module('@/lib/mission-claim-deferrals', () => ({ loadClaimHoldReasons: async () => new Map() }));

const { getMissionVisualReviewState } = await import('./visual-review-state-load');
beforeEach(() => { loadSurfaceAuditWaiver.mockClear(); loadVisualReview.mockClear(); evaluateSurfaceAuditGate.mockClear(); });

it("reuses the caller's waiver and model reads instead of repeating them", async () => {
  const state = await getMissionVisualReviewState('m1', { waiver: Promise.resolve(null), model: { audit: null } as any });
  expect(state).not.toBeNull();
  expect(loadSurfaceAuditWaiver).not.toHaveBeenCalled();
  expect(loadVisualReview).not.toHaveBeenCalled();
});

it('loads them itself for a caller that holds neither', async () => {
  await getMissionVisualReviewState('m1');
  expect(loadSurfaceAuditWaiver).toHaveBeenCalledTimes(1);
  expect(loadVisualReview).toHaveBeenCalledTimes(1);
});

it('evaluates the gate as a render read: it never records merged evidence', async () => {
  await getMissionVisualReviewState('m1');
  expect(evaluateSurfaceAuditGate.mock.calls[0][2]).toBeUndefined();
});
