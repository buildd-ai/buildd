/**
 * Who decides for a delivery (authority.ts, docs/specs/workflow-state-kernel.md
 * §14): the kill switch and the sticky release are one statement each. The
 * statements run on real Postgres in apps/web/tests/db/workflow-seam.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { kernelEnabled, releaseSql, resolveByIdSql, resolveByOwnerSql, resolveByPrSql } from './authority';

const render = (q: SQL) => new PgDialect().sqlToQuery(q);

describe('kill switch', () => {
  test('absent or true is on; false or "off" hands deliveries back', () => {
    expect(kernelEnabled(null)).toBe(true);
    expect(kernelEnabled({})).toBe(true);
    expect(kernelEnabled({ workflowKernel: true })).toBe(true);
    expect(kernelEnabled({ workflowKernel: false })).toBe(false);
    expect(kernelEnabled({ workflowKernel: 'off' })).toBe(false);
  });
});

describe('SQL', () => {
  test('resolving reads the switch from the workspace and releases in the same statement', () => {
    for (const q of [resolveByIdSql('d1'), resolveByPrSql('w1', 'acme/w', 7), resolveByOwnerSql('w1', 't1')]) {
      const { sql: text } = render(q);
      expect(text).toContain("(w.git_config->>'workflowKernel') IN ('false', 'off')");
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
