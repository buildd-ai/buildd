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
  // A uuid range, not `id::text like 'p%'`: the text cast defeats the primary-key
  // index, so a prefix matching nothing (the common 404) scanned every tenant's tasks.
  it('bounds tasks.id by a uuid range so the primary-key index applies', () => {
    const q = dialect.sqlToQuery(taskIdPrefixPredicate('ABCDEF12'));
    expect(q.sql).toBe('("tasks"."id" >= $1::uuid and "tasks"."id" <= $2::uuid)');
    expect(q.params).toEqual([
      'abcdef12-0000-0000-0000-000000000000',
      'abcdef12-ffff-ffff-ffff-ffffffffffff',
    ]);
    expect(q.sql).not.toContain('::text');
  });

  it('pads a dashed partial prefix into the right uuid groups', () => {
    const q = dialect.sqlToQuery(taskIdPrefixPredicate('abcdef12-34'));
    expect(q.params).toEqual([
      'abcdef12-3400-0000-0000-000000000000',
      'abcdef12-34ff-ffff-ffff-ffffffffffff',
    ]);
  });

  it('bounds contain exactly the ids that start with the prefix', () => {
    const q = dialect.sqlToQuery(taskIdPrefixPredicate('abcdef12-3456'));
    const [lo, hi] = q.params as string[];
    const inRange = (id: string) => id >= lo && id <= hi;
    expect(inRange(FULL)).toBe(true);
    expect(inRange('abcdef12-3457-0000-0000-000000000000')).toBe(false);
    expect(inRange('abcdef12-3455-ffff-ffff-ffffffffffff')).toBe(false);
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
    expect(q.params).toEqual([
      'abcdef12-3456-0000-0000-000000000000',
      'abcdef12-3456-ffff-ffff-ffffffffffff',
    ]);
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
    // 'abcdef123-' / 'abcdef12--' put a dash where no uuid has one.
    for (const bad of ['abcdef1', 'zzzzzzzz', 'task-abc', "abcdef12'--", '', 'abcdef123-', 'abcdef12--']) {
      const r = await resolveTaskIdForCaller(bad, allowAll);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    expect(mockCandidates).not.toHaveBeenCalled();
  });
});
