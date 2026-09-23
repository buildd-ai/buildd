import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockCandidates = mock(() => Promise.resolve([] as any[]));
const whereArgs: unknown[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          whereArgs.push(w);
          return { limit: () => mockCandidates() };
        },
      }),
    }),
  },
}));

import { resolveTaskIdForCaller, taskIdPrefixPredicate } from './resolve-task-id';

const dialect = new PgDialect();
const FULL = 'abcdef12-3456-4789-8abc-def012345678';

describe('taskIdPrefixPredicate', () => {
  it('matches on the text form of tasks.id with a trailing wildcard, lowercased', () => {
    const q = dialect.sqlToQuery(taskIdPrefixPredicate('ABCDEF12'));
    expect(q.sql).toBe('"tasks"."id"::text like $1');
    expect(q.params).toEqual(['abcdef12%']);
  });
});

describe('resolveTaskIdForCaller', () => {
  beforeEach(() => {
    mockCandidates.mockReset();
    mockCandidates.mockResolvedValue([]);
    whereArgs.length = 0;
  });

  const allowAll = async () => true;

  it('passes a full UUID straight through without a lookup', async () => {
    const r = await resolveTaskIdForCaller(FULL, allowAll);
    expect(r).toEqual({ ok: true, id: FULL });
    expect(mockCandidates).not.toHaveBeenCalled();
  });

  it('resolves a unique 8-char prefix the caller can access', async () => {
    mockCandidates.mockResolvedValue([{ id: FULL, title: 'T', workspaceId: 'ws-1' }]);
    const r = await resolveTaskIdForCaller('abcdef12', allowAll);
    expect(r).toEqual({ ok: true, id: FULL, resolvedFrom: 'abcdef12' });
  });

  it('accepts a dashed partial UUID prefix', async () => {
    mockCandidates.mockResolvedValue([{ id: FULL, title: 'T', workspaceId: 'ws-1' }]);
    const r = await resolveTaskIdForCaller('abcdef12-3456', allowAll);
    expect(r.ok).toBe(true);
    const q = dialect.sqlToQuery(whereArgs[0] as any);
    expect(q.params).toEqual(['abcdef12-3456%']);
  });

  it('404s when the only match is in a workspace the caller cannot access (no existence leak)', async () => {
    mockCandidates.mockResolvedValue([{ id: FULL, title: 'Secret', workspaceId: 'ws-other' }]);
    const r = await resolveTaskIdForCaller('abcdef12', async (ws) => ws === 'ws-mine');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.candidates).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain('Secret');
    }
  });

  it('409s with only the accessible candidates when a prefix is ambiguous', async () => {
    const other = 'abcdef12-0000-4000-8000-000000000000';
    const hidden = 'abcdef12-1111-4000-8000-000000000000';
    mockCandidates.mockResolvedValue([
      { id: FULL, title: 'A', workspaceId: 'ws-mine' },
      { id: other, title: 'B', workspaceId: 'ws-mine' },
      { id: hidden, title: 'Hidden', workspaceId: 'ws-other' },
    ]);
    const r = await resolveTaskIdForCaller('abcdef12', async (ws) => ws === 'ws-mine');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.candidates).toEqual([{ id: FULL, title: 'A' }, { id: other, title: 'B' }]);
    }
  });

  it('400s on prefixes shorter than 8 chars and on non-hex input, without a lookup', async () => {
    for (const bad of ['abcdef1', 'zzzzzzzz', 'task-abc', "abcdef12'--", '']) {
      const r = await resolveTaskIdForCaller(bad, allowAll);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    expect(mockCandidates).not.toHaveBeenCalled();
  });
});
