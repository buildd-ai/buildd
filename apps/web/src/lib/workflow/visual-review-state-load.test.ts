import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { capturedWhere } from '@buildd/core/db/relational-sql';
import { isMissionAuditTask } from '@buildd/core/surface-audit';

/** The mission page already holds the waiver and the visual-review model: the state load reuses them. */
let captured: any = null;
let rows: any[] = [];
mock.module('server-only', () => ({}));
mock.module('@buildd/core/db', () => ({ db: { query: {
  missions: { findFirst: async () => ({ id: 'm1', status: 'active', workspaceId: 'ws', autoSurfaceAudit: true, workingBranch: null, primaryPrNumber: null }) },
  workspaces: { findFirst: async () => ({ gitConfig: null, githubRepoId: null }) },
  tasks: { findMany: async (cfg: any) => { captured = cfg; return rows; } },
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
beforeEach(() => { rows = []; loadSurfaceAuditWaiver.mockClear(); loadVisualReview.mockClear(); evaluateSurfaceAuditGate.mockClear(); });

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

/**
 * The ledger reads the same audit identity as mission state (isMissionAuditTask):
 * the title prefix OR the visual-auditor role. Renders the captured predicate
 * through PgDialect, since a mocked db would hide it.
 */
describe('loadMissionAuditLedger identity', () => {
  it('selects role-only and title-only audits, and reads roleSlug', async () => {
    await loadMissionAuditLedger('m1');
    const { sql, params } = new PgDialect().sqlToQuery(capturedWhere(captured.where));
    expect(sql).toMatch(/"role_slug" = \$\d+/);
    expect(sql).toMatch(/"title" like \$\d+/);
    expect(params).toContain('visual-auditor');
    expect(params).toContain('[surface audit] %');
    expect(captured.columns.roleSlug).toBe(true);
  });

  it('every shape isMissionAuditTask accepts is one the ledger predicate admits', () => {
    const shapes = [
      { title: '[surface audit] Mission', roleSlug: null },
      { title: 'Check the screens', roleSlug: 'visual-auditor' },
    ];
    expect(shapes.every(isMissionAuditTask)).toBe(true);
  });
});
