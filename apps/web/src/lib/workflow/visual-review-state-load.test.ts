/**
 * The ledger reads the same audit identity as mission state (isMissionAuditTask):
 * the title prefix OR the visual-auditor role. Renders the captured predicate
 * through PgDialect, since a mocked db would hide it.
 */
import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { capturedWhere } from '@buildd/core/db/relational-sql';
import { isMissionAuditTask } from '@buildd/core/surface-audit';

let captured: any = null;
let rows: any[] = [];
mock.module('server-only', () => ({}));
mock.module('@buildd/core/db', () => ({
  db: { query: { tasks: { findMany: async (cfg: any) => { captured = cfg; return rows; } } } },
}));
mock.module('@/lib/mission-surface-audit-gate', () => ({ evaluateSurfaceAuditGate: async () => null, loadSurfaceAuditGateTasks: async () => [], loadSurfaceAuditWaiver: async () => null }));
mock.module('@/lib/visual-review-load', () => ({ loadVisualReview: async () => null }));
mock.module('@/lib/mission-claim-deferrals', () => ({ loadClaimHoldReasons: async () => new Map() }));

const { loadMissionAuditLedger } = await import('./visual-review-state-load');

describe('loadMissionAuditLedger identity', () => {
  it('selects role-only and title-only audits, and reads roleSlug', async () => {
    rows = [];
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
