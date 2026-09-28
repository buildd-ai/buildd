/**
 * find_decayed reads real use for memory: the memory_uses ledger (pulls and
 * completed-task use), not hit_count, which pushes used to inflate (task
 * d1997424). Rendered through the real PgDialect: knowledge-consolidation.test.ts
 * replaces drizzle-orm with a recorder, so it cannot catch broken SQL.
 */
import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const executed: SQL[] = [];
mock.module('../db/index', () => ({
  db: { execute: async (q: SQL) => { executed.push(q); return { rows: [] }; } },
}));

const { decayedUnusedClause, findDecayedUnused } = await import('../knowledge-store/consolidation');

const TEAM = '11111111-1111-4111-8111-111111111111';
const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('decayedUnusedClause', () => {
  it('memory: no ledger row showing a pull or a used outcome', () => {
    const q = render(decayedUnusedClause(`${TEAM}:memory`, 'memory'));
    expect(squash(q.sql)).toBe(
      "NOT EXISTS ( SELECT 1 FROM memory_uses mu WHERE mu.team_id = $1::uuid AND mu.memory_id = knowledge_chunks.source_id AND (mu.via = 'pull' OR mu.outcome = 'used') )",
    );
    expect(q.params).toEqual([TEAM]);
  });

  it('other corpora keep hit_count = 0', () => {
    expect(render(decayedUnusedClause('ws-1:task', 'task')).sql).toBe('hit_count = 0');
  });

  it('a memory namespace without a UUID scope falls back to hit_count', () => {
    expect(render(decayedUnusedClause('team-1:memory', 'memory')).sql).toBe('hit_count = 0');
  });
});

describe('findDecayedUnused renders one valid query across mixed corpora', () => {
  it('memory reads the ledger, task reads hit_count, both under their own cutoff', async () => {
    executed.length = 0;
    const now = new Date('2026-07-01T00:00:00.000Z');
    await findDecayedUnused([`${TEAM}:memory`, 'ws-1:task'], { now, limit: 10 });
    expect(executed).toHaveLength(1);
    const q = render(executed[0]);
    const text = squash(q.sql);
    expect(text).toContain('WHERE is_current = true AND source_ts IS NOT NULL AND (');
    expect(text).toContain('(namespace = $1 AND source_ts < $2 AND NOT EXISTS ( SELECT 1 FROM memory_uses mu WHERE mu.team_id = $3::uuid');
    expect(text).toContain('OR (namespace = $4 AND source_ts < $5 AND hit_count = 0)');
    expect(text).not.toMatch(/AND hit_count = 0 AND source_ts IS NOT NULL/);
    expect(q.params).toEqual([
      `${TEAM}:memory`, expect.any(String), TEAM,
      'ws-1:task', expect.any(String),
      10,
    ]);
  });
});
