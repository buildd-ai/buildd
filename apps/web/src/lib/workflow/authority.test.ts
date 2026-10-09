/**
 * Who decides for a delivery (authority.ts, docs/specs/workflow-state-kernel.md
 * §14): the kill switch and the sticky release are one statement each. The
 * statements run on real Postgres in apps/web/tests/db/workflow-seam.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql as sqlTag, type SQL } from 'drizzle-orm';
import { claimLegacyHandoffSql, kernelEnabled, kernelOnSql, releaseSql, unclaimLegacyHandoffSql, workspaceKernelOnSql, resolveByIdSql, resolveByOwnerSql, resolveByPrSql } from './authority';

const render = (q: SQL) => new PgDialect().sqlToQuery(q);

describe('kill switch', () => {
  test('absent, null, true, "true" and "on" are on; every other value hands deliveries back', () => {
    expect(kernelEnabled(null)).toBe(true);
    expect(kernelEnabled({})).toBe(true);
    expect(kernelEnabled({ workflowKernel: null })).toBe(true);
    expect(kernelEnabled({ workflowKernel: true })).toBe(true);
    expect(kernelEnabled({ workflowKernel: 'true' })).toBe(true);
    expect(kernelEnabled({ workflowKernel: 'on' })).toBe(true);
    expect(kernelEnabled({ workflowKernel: false })).toBe(false);
    expect(kernelEnabled({ workflowKernel: 'false' })).toBe(false);
    expect(kernelEnabled({ workflowKernel: 'off' })).toBe(false);
    // Unrecognised values fail toward legacy: an emergency switch never needs the exact spelling.
    for (const v of ['', 'no', 'disabled', 'TRUE', 0, 1, {}]) expect(kernelEnabled({ workflowKernel: v })).toBe(false);
  });

  test('the SQL reading treats a missing key as on and accepts only the on spellings', () => {
    const { sql: text } = render(kernelOnSql(sqlTag`w.git_config`));
    expect(text).toBe("(COALESCE((w.git_config)->>'workflowKernel', 'true') IN ('true', 'on'))");
  });
});

describe('SQL', () => {
  test('resolving reads the switch from the workspace and releases in the same statement', () => {
    for (const q of [resolveByIdSql('d1'), resolveByPrSql('w1', 'acme/w', 7), resolveByOwnerSql('w1', 't1')]) {
      const { sql: text } = render(q);
      expect(text).toContain("NOT (COALESCE((w.git_config)->>'workflowKernel', 'true') IN ('true', 'on')) AS switched_off");
      expect(text).toContain("SET authority = 'legacy', released_at = now()");
      expect(text).toContain("x.authority = 'kernel' AND d.switched_off");
      // A released delivery stays legacy whatever the switch says now.
      expect(text).toContain("WHEN d.authority = 'legacy' OR EXISTS (SELECT 1 FROM rel) THEN 'legacy'");
    }
    expect(render(resolveByPrSql('w1', 'acme/w', 7)).params).toEqual(['w1', 'acme/w', 7]);
    expect(render(resolveByOwnerSql('w1', 't1')).params).toEqual(['w1', 't1']);
    expect(render(resolveByIdSql('d1')).params).toEqual(['d1']);
  });

  test('an explicit release only ever moves kernel → legacy', () => {
    const { sql: text, params } = render(releaseSql('d1'));
    expect(text).toContain("WHERE id = $1::uuid AND authority = 'kernel'");
    expect(params).toEqual(['d1']);
  });
});

describe('§14 hand-off SQL', () => {
  test('a workspace id reads the switch through the same predicate; no workspace row reads as on', () => {
    const { sql: text } = render(workspaceKernelOnSql(sqlTag`d.workspace_id`));
    expect(text).toBe("NOT EXISTS (SELECT 1 FROM workspaces kw WHERE kw.id = d.workspace_id AND NOT (COALESCE((kw.git_config)->>'workflowKernel', 'true') IN ('true', 'on')))");
  });
  test('the hand-off is claimed once per owner task and can be given back', () => {
    const claim = render(claimLegacyHandoffSql('t1', 'd1'));
    expect(claim.sql).toContain("WHERE id = $2::uuid AND NOT COALESCE(context ? 'workflowLegacyHandoff', false)");
    expect(claim.sql).toContain("jsonb_build_object('workflowLegacyHandoff', jsonb_build_object('deliveryId', $1::text, 'at', now()))");
    expect(claim.params).toEqual(['d1', 't1']);
    const back = render(unclaimLegacyHandoffSql('t1'));
    expect(back.sql).toContain("SET context = context - 'workflowLegacyHandoff' WHERE id = $1::uuid");
  });
});
