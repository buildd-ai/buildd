/**
 * The two narrowed reads behind `buildd top`'s mission stages, rendered to SQL
 * against the real schema (knowledge-base: buildd/reports/core-page-performance-2026-10-17.md):
 * the task read projects only the context keys the stage reads, and the
 * worker read keeps the newest few per task plus every PR-bearing one.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DELIVERABLE_ROLE_CONTEXT_KEYS } from '@buildd/core/mission-helpers';
import { LATEST_WORKERS_PER_TASK, stageContextSql, stageWorkersPredicate } from './mission-stage-sql';

const dialect = new PgDialect();

describe('stageContextSql', () => {
  const { sql: text } = dialect.sqlToQuery(stageContextSql);

  it('projects each key deliverableRole reads, and only those', () => {
    const all = [...DELIVERABLE_ROLE_CONTEXT_KEYS.objectMarkers, ...DELIVERABLE_ROLE_CONTEXT_KEYS.values];
    for (const k of all) expect(text).toContain(`'${k}'`);
    const projected = [...text.matchAll(/(?<!-> )'([A-Za-z]+)',/g)].map(m => m[1]);
    expect(projected.sort()).toEqual([...all].sort());
  });

  it('never selects the whole context: every reference is a key read', () => {
    const refs = text.match(/"context"(?!\s*->)/g) ?? [];
    expect(refs).toEqual([]);
  });

  it('reduces an object marker to an empty object, so a large marker never travels', () => {
    for (const k of DELIVERABLE_ROLE_CONTEXT_KEYS.objectMarkers) {
      expect(text).toMatch(new RegExp(`jsonb_typeof\\("tasks"\\."context"\\s*->\\s*'${k}'\\)\\s*=\\s*'object'\\s+then\\s+'\\{\\}'::jsonb`));
    }
  });
});

describe('stageWorkersPredicate', () => {
  const q = dialect.sqlToQuery(stageWorkersPredicate());

  it('keeps every PR-bearing worker', () => {
    expect(q.sql).toContain('"workers"."pr_url" is not null');
  });

  it('otherwise keeps only the newest few per task, never-started first, ties by id', () => {
    expect(LATEST_WORKERS_PER_TASK).toBeGreaterThan(0);
    expect(LATEST_WORKERS_PER_TASK).toBeLessThanOrEqual(5);
    expect(q.sql).toContain('from "workers" "w_newer" where "w_newer"."task_id" = "workers"."task_id"');
    expect(q.sql).toMatch(/coalesce\("w_newer"\."started_at", 'infinity'::timestamptz\), "w_newer"\."id"\) > \(coalesce\("workers"\."started_at", 'infinity'::timestamptz\), "workers"\."id"\)/);
    expect(q.params).toContain(LATEST_WORKERS_PER_TASK);
  });
});
