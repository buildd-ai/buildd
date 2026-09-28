/**
 * memory_uses retention: rows older than the retention window are deleted in
 * one bounded batch per run, oldest first, so a backlog drains over several
 * runs instead of one unbounded DELETE.
 */
import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const executed: SQL[] = [];
let deletedRows = 0;
mock.module('../db', () => ({
  db: {
    execute: async (q: SQL) => {
      executed.push(q);
      return { rows: Array.from({ length: deletedRows }, (_, i) => ({ id: `r${i}` })), rowCount: deletedRows };
    },
  },
}));

const { pruneMemoryUsesSql, pruneMemoryUses, MEMORY_USES_RETENTION_DAYS, pruneMemoryDecisionsSql, pruneMemoryDecisions, MEMORY_DECISIONS_RETENTION_DAYS } = await import('../memory-uses-retention');

const dialect = new PgDialect();
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('pruneMemoryUsesSql', () => {
  it('deletes a bounded, oldest-first batch older than the cutoff', () => {
    const cutoff = new Date('2026-06-01T00:00:00.000Z');
    const q = dialect.sqlToQuery(pruneMemoryUsesSql(cutoff, 500));
    expect(squash(q.sql)).toBe(
      'DELETE FROM "memory_uses" WHERE "memory_uses"."id" IN ( SELECT "memory_uses"."id" FROM "memory_uses" WHERE "memory_uses"."created_at" < $1 ORDER BY "memory_uses"."created_at" LIMIT $2 ) RETURNING "memory_uses"."id"',
    );
    expect(q.params).toEqual([cutoff.toISOString(), 500]);
  });
});

describe('pruneMemoryUses', () => {
  it('runs one statement with the retention cutoff and reports what it deleted', async () => {
    executed.length = 0;
    deletedRows = 3;
    const now = new Date('2026-09-01T00:00:00.000Z');
    const res = await pruneMemoryUses({ now });
    expect(executed).toHaveLength(1);
    const q = dialect.sqlToQuery(executed[0]);
    const cutoff = new Date(now.getTime() - MEMORY_USES_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(q.params[0]).toBe(cutoff.toISOString());
    expect(res).toEqual({ deleted: 3, cutoff: cutoff.toISOString(), batchFull: false });
  });

  it('caps the batch and says when it was full', async () => {
    executed.length = 0;
    deletedRows = 2;
    const res = await pruneMemoryUses({ now: new Date(), batchSize: 2 });
    expect(dialect.sqlToQuery(executed[0]).params[1]).toBe(2);
    expect(res.batchFull).toBe(true);
  });

  it('retention defaults to 90 days', () => {
    expect(MEMORY_USES_RETENTION_DAYS).toBe(90);
  });
});

describe('pruneMemoryDecisions', () => {
  it('deletes a bounded, oldest-first batch of memory_decisions older than 90 days', async () => {
    const cutoff = new Date('2026-06-01T00:00:00.000Z');
    const q = dialect.sqlToQuery(pruneMemoryDecisionsSql(cutoff, 500));
    expect(squash(q.sql)).toBe(
      'DELETE FROM "memory_decisions" WHERE "memory_decisions"."id" IN ( SELECT "memory_decisions"."id" FROM "memory_decisions" WHERE "memory_decisions"."created_at" < $1 ORDER BY "memory_decisions"."created_at" LIMIT $2 ) RETURNING "memory_decisions"."id"',
    );
    expect(q.params).toEqual([cutoff.toISOString(), 500]);
    expect(MEMORY_DECISIONS_RETENTION_DAYS).toBe(90);

    executed.length = 0;
    deletedRows = 2;
    const res = await pruneMemoryDecisions({ now: new Date(), batchSize: 2 });
    expect(executed).toHaveLength(1);
    expect(res.batchFull).toBe(true);
  });
});
