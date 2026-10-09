import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('../db/client', () => ({ db: {} }));
const src = await import('../task-estimate-backtest-source');
const dialect = new PgDialect();

describe('backtest cohort', () => {
  it('replays completed work tasks only', () => {
    const q = dialect.sqlToQuery(src.backtestTaskScope()!);
    expect(q.sql).toContain('"task_class" = $');
    expect(q.sql).toContain('"status" = $');
    expect(q.params).toEqual(['work', 'completed']);
  });

  it('sizes from completed sessions that have a start and an end', () => {
    const q = dialect.sqlToQuery(src.backtestSessionScope(['t1'])!);
    expect(q.sql).toContain('"started_at" is not null');
    expect(q.sql).toContain('"completed_at" is not null');
    expect(q.params).toContain('completed');
  });
});

describe('vectorNeighbours', () => {
  const task = { taskId: 't', workspaceId: 'w', createdAt: new Date(0), kind: null, complexity: null, seedText: 'fix the thing' };

  it('keeps only visible ids, in the store\'s rank order', async () => {
    const store = { query: async () => [{ id: 'task:' + 'b'.repeat(8) + '-0000-0000-0000-' + 'c'.repeat(12), metadata: { taskId: 'later' }, score: 0.9 }, { id: 'x', metadata: { taskId: 'seen' }, score: 0.5 }] } as any;
    const out = await src.vectorNeighbours(store)(task, new Set(['seen']));
    expect(out).toEqual(['seen']);
  });

  it('degrades to no neighbours when the store fails', async () => {
    const store = { query: async () => { throw new Error('down'); } } as any;
    expect(await src.vectorNeighbours(store)(task, new Set(['a']))).toEqual([]);
  });
});
