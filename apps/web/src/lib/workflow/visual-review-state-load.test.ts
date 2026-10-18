import { beforeEach, expect, it, mock } from 'bun:test';

/** The mission page already holds the waiver and the visual-review model: the state load reuses them. */
mock.module('server-only', () => ({}));
const reads: string[] = [];
// The audit ledger's select: the chain resolves to no audits.
const selectChain: any = { from: () => selectChain, where: () => selectChain, orderBy: () => selectChain, limit: () => selectChain, then: (res: (v: unknown) => unknown) => { reads.push('ledger'); return Promise.resolve([]).then(res); } };
mock.module('@buildd/core/db', () => ({ db: { select: () => selectChain, query: {
  missions: { findFirst: async () => { reads.push('missions'); return { id: 'm1', status: 'active', workspaceId: 'ws', autoSurfaceAudit: true, workingBranch: null, primaryPrNumber: null }; } },
  workspaces: { findFirst: async () => { reads.push('workspaces'); return { gitConfig: null, githubRepoId: null }; } },
  tasks: { findMany: async () => { reads.push('tasks'); return []; } },
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
beforeEach(() => { reads.length = 0; loadSurfaceAuditWaiver.mockClear(); loadVisualReview.mockClear(); evaluateSurfaceAuditGate.mockClear(); });

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

it('evaluates the gate as a display read: it never records merged evidence', async () => {
  await getMissionVisualReviewState('m1');
  expect(evaluateSurfaceAuditGate.mock.calls[0][2]?.fillMergedEvidence).toBeUndefined();
});

it('a page passes what it holds: no mission, workspace, task or ledger read, and the gate never asks GitHub (spec 3ef37387 R-12)', async () => {
  const state = await getMissionVisualReviewState('m1', {
    render: true,
    mission: { id: 'm1', status: 'active', workspaceId: 'ws', autoSurfaceAudit: true, workingBranch: null, primaryPrNumber: null },
    gitConfig: null,
    tasks: [],
    ledger: [],
    waiver: Promise.resolve(null),
    model: { audit: null } as any,
  });
  expect(state).not.toBeNull();
  expect(reads).toEqual([]);
  expect(evaluateSurfaceAuditGate.mock.calls[0][2]).toMatchObject({ render: true, waived: false });
});

it('a caller that names the UI change (the scheduler, from the classifier) gets no gate read', async () => {
  await getMissionVisualReviewState('m1', { uiChange: { state: 'yes', source: 'diff', uiFiles: 1 }, waiver: Promise.resolve(null), model: { audit: null } as any });
  expect(evaluateSurfaceAuditGate).not.toHaveBeenCalled();
});

it('a caller holding the delivery, ledger and claim holds reads none of them', async () => {
  const state = await getMissionVisualReviewState('m1', {
    mission: { id: 'm1', status: 'active', workspaceId: 'ws', autoSurfaceAudit: true, workingBranch: null, primaryPrNumber: 7 },
    gitConfig: null, tasks: [], ledger: [], waiver: Promise.resolve(null), model: { audit: null } as any,
    delivery: { state: 'OPEN', currentHeadSha: 'abc1234', baseRef: 'dev' }, holdReasons: new Map(),
  });
  expect(reads).toEqual([]);
  expect(state?.branch.headSha).toBe('abc1234');
});
