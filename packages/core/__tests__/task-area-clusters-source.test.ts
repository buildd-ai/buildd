import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const predicates: SQL[] = [];
mock.module('../db/client', () => ({ db: {
  select: () => ({ from: () => ({ where: (predicate: SQL) => {
    predicates.push(predicate);
    return { groupBy: async () => [{ parent: 'task-example', n: 2 }] };
  } }) }),
} }));
const { loadRepairCounts } = await import('../task-area-clusters-source');

describe('repair-count historical cutoff', () => {
  it('excludes attempts created at or after the requested model cutoff', async () => {
    const cutoff = new Date('2026-10-01T00:00:00Z');
    expect(await loadRepairCounts(['task-example'], { asOf: cutoff })).toEqual(new Map([['task-example', 2]]));
    const q = new PgDialect().sqlToQuery(predicates.at(-1)!);
    expect(q.sql).toContain('"tasks"."created_at" <');
    expect(q.params).toContain(cutoff.toISOString());
  });
  it('preserves all-time counting for callers without a cutoff', async () => {
    await loadRepairCounts(['task-example']);
    const q = new PgDialect().sqlToQuery(predicates.at(-1)!);
    expect(q.sql).not.toContain('created_at');
  });
});
