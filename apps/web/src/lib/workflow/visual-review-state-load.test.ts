import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isMissionAuditTask } from '@buildd/core/surface-audit';

/** The mission page already holds the waiver and the visual-review model: the state load reuses them. */
mock.module('server-only', () => ({}));
const reads: string[] = [];
// The audit ledger's select: the chain resolves to no audits.
let ledgerWhere: any = null;
const selectChain: any = { from: () => selectChain, where: (w: any) => { ledgerWhere = w; return selectChain; }, orderBy: () => selectChain, limit: () => selectChain, then: (res: (v: unknown) => unknown) => { reads.push('ledger'); return Promise.resolve([]).then(res); } };
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

const { getMissionVisualReviewState, loadMissionAuditLedger } = await import('./visual-review-state-load');
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

/**
 * The ledger reads the same audit identity as mission state (isMissionAuditTask):
 * the title prefix OR the visual-auditor role. Renders the captured predicate
 * through PgDialect, since a mocked db would hide it.
 */
describe('loadMissionAuditLedger identity', () => {
  it('selects role-only and title-only audits', async () => {
    await loadMissionAuditLedger('m1');
    const { sql, params } = new PgDialect().sqlToQuery(ledgerWhere);
    expect(sql).toMatch(/"role_slug" = \$\d+/);
    expect(sql).toMatch(/"title" like \$\d+/);
    expect(params).toContain('visual-auditor');
    expect(params).toContain('[surface audit] %');
  });

  it('every shape isMissionAuditTask accepts is one the ledger predicate admits', () => {
    const shapes = [
      { title: '[surface audit] Mission', roleSlug: null },
      { title: 'Check the screens', roleSlug: 'visual-auditor' },
    ];
    expect(shapes.every(isMissionAuditTask)).toBe(true);
  });
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

/** A `needed` review waits on the scheduler; when the scheduler's answer is "blocked" the state says so and names who acts. */
describe('scheduler block on a needed review', () => {
  const HEAD = 'aaaa1111';
  const load = (ledger: any[]) => getMissionVisualReviewState('m1', {
    uiChange: { state: 'yes', source: 'diff', uiFiles: 2 },
    mission: { id: 'm1', status: 'active', workspaceId: 'ws', autoSurfaceAudit: true, workingBranch: null, primaryPrNumber: 9 },
    gitConfig: null,
    tasks: [{ id: 't1', taskClass: 'work', status: 'completed', title: 'Build', roleSlug: 'builder' }] as any,
    delivery: { state: 'open', currentHeadSha: HEAD, baseRef: 'dev' },
    ledger,
    waiver: Promise.resolve(null),
    model: { audit: null } as any,
  });
  const au = (over: Record<string, unknown> = {}) => ({ id: 'a1', status: 'completed', round: 1, headSha: 'old00000', updatedAt: 1, ...over });

  it('five finished rounds on a landed UI mission: rereview_cap, owner next', async () => {
    const ledger = Array.from({ length: 5 }, (_, i) => au({ id: `d${i}`, round: 5 - i, headSha: `old0000${i}` }));
    const state = await load(ledger);
    expect(state?.status).toBe('needed');
    expect(state?.scheduleBlock?.cause).toBe('rereview_cap');
    expect(state?.nextActor).toBe('owner');
  });

  it('cancelled on this head: audit_cancelled, owner next', async () => {
    const state = await load([au({ status: 'cancelled', headSha: HEAD })]);
    expect(state?.scheduleBlock?.cause).toBe('audit_cancelled');
    expect(state?.nextActor).toBe('owner');
  });

  it('a plannable action leaves the state alone: no block, system next', async () => {
    for (const ledger of [[], [au({ status: 'failed', headSha: HEAD, updatedAt: Date.now() })]]) {
      const state = await load(ledger);
      expect(state?.status).toBe('needed');
      expect(state?.scheduleBlock).toBeUndefined();
      expect(state?.nextActor).toBe('system');
    }
  });
});
