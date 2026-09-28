/**
 * Supersession is recorded on the memories row, not only in the index, so a
 * memory superseded while it had no chunk (or while the mirror was down) is
 * not later re-indexed as current. The UPDATE is bound to the store's team.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const updates: Array<{ set: Record<string, unknown>; where: unknown }> = [];

mock.module('../db', () => ({
  db: {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updates.push({ set, where });
          return { returning: async () => [{ id: 'old-1' }] };
        },
      }),
    }),
  },
}));

const { MemoryStore } = await import('../memory-store');

beforeEach(() => { updates.length = 0; });

describe('MemoryStore.markSuperseded', () => {
  it('writes superseded_by on the listed rows, bound to the team and excluding the new row', async () => {
    const n = await new MemoryStore('team-a').markSuperseded(['old-1', 'new-1'], 'new-1');
    expect(n).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ supersededBy: 'new-1' });
    const q = dialect.sqlToQuery(updates[0].where as any);
    expect(q.sql).toContain('"memories"."team_id" = $');
    expect(q.params).toContain('team-a');
    expect(q.params).toContain('old-1');
    expect(q.params).not.toContain('new-1');
  });

  it('does nothing for an empty list', async () => {
    expect(await new MemoryStore('team-a').markSuperseded([], 'new-1')).toBe(0);
    expect(await new MemoryStore('team-a').markSuperseded(['new-1'], 'new-1')).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
