/**
 * The mission page must release a dependency exactly when the claim gate does
 * (spec f7f67f1a P-1, AC-3). The claim gate's per-edge arms live in one record
 * (`DEP_EDGE_ARM_SQL`) that `dependencySatisfied()` ORs and the page's loader
 * (`edgeFactsSql`) selects arm by arm. These tests fail when the gate gains an
 * arm the display does not read.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isNull, or, sql } from 'drizzle-orm';
import { DEP_EDGE_ARM_SQL, dependencySatisfied, depsGate, outsideSurfaceAuditMission } from '@/app/api/workers/claim/deps-gate';
import { BYPASS_DEPS_GATE_KEY, bypassFlagCondition } from '@/lib/bypass-flags';
import { tasks } from '@buildd/core/db/schema';
import { DEP_EDGE_RELEASE_ARMS, DEP_GATE_RELEASE_ARMS } from '@/lib/dep-gate-contract';
import { edgeFactsSql, edgeReleaseArm, type EdgeFactsRow } from '@/lib/mission-board-waiting';

const dialect = new PgDialect();
/** Rendered SQL with comments, whitespace and placeholder numbers normalised: a fragment's $n shifts with its position. */
const text = (q: Parameters<PgDialect['sqlToQuery']>[0]) =>
  dialect.sqlToQuery(q).sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').replace(/\$\d+/g, '$').trim();
const DEP = sql`dep_id::uuid`;

describe('claim gate and mission page read the same dependency arms', () => {
  it('the gate record names exactly the contract\'s per-edge arms, in order', () => {
    expect(Object.keys(DEP_EDGE_ARM_SQL)).toEqual([...DEP_EDGE_RELEASE_ARMS]);
  });

  it('dependencySatisfied is the OR of the record and nothing else', () => {
    const fromRecord = text(sql`(${sql.join(DEP_EDGE_RELEASE_ARMS.map((a) => DEP_EDGE_ARM_SQL[a](DEP)), sql` OR `)})`);
    expect(text(dependencySatisfied(DEP))).toBe(fromRecord);
  });

  it('the whole gate is no dependencies, the bypass flag, or every edge released by an arm or the surface-audit scope', () => {
    expect([...DEP_GATE_RELEASE_ARMS]).toEqual(['surface_audit_scope', 'bypass']);
    const composed = or(
      isNull(tasks.dependsOn),
      sql`${tasks.dependsOn}::jsonb = '[]'::jsonb`,
      bypassFlagCondition(tasks.context, BYPASS_DEPS_GATE_KEY),
      sql`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${tasks.dependsOn}::jsonb) AS dep_id
    WHERE NOT ${dependencySatisfied(DEP)}
    AND NOT ${outsideSurfaceAuditMission(DEP)}
  )`,
    )!;
    expect(text(depsGate())).toBe(text(composed));
  });

  it('the page selects every arm, each as its own column', () => {
    const q = text(edgeFactsSql('00000000-0000-4000-8000-000000000001'));
    for (const arm of DEP_EDGE_RELEASE_ARMS) {
      expect(q).toContain(`${text(DEP_EDGE_ARM_SQL[arm](DEP))} AS "arm_${arm}"`);
    }
    expect(q).toContain(`${text(outsideSurfaceAuditMission(DEP))} AS arm_surface_audit_scope`);
    expect(q).toContain(`${text(bypassFlagCondition(tasks.context, BYPASS_DEPS_GATE_KEY))} AS arm_bypass`);
  });

  it('every non-status arm, alone, releases an edge on the page', () => {
    const base = Object.fromEntries([...DEP_EDGE_RELEASE_ARMS, ...DEP_GATE_RELEASE_ARMS].map((a) => [`arm_${a}`, false]));
    for (const arm of [...DEP_EDGE_RELEASE_ARMS, ...DEP_GATE_RELEASE_ARMS].filter((a) => a !== 'status')) {
      const row = { dependent_id: 'b', dependency_id: 'a', inferred: false, ...base, [`arm_${arm}`]: true } as EdgeFactsRow;
      expect(edgeReleaseArm(row)).toBe(arm);
    }
  });
});
