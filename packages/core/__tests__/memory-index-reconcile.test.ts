/**
 * Reconcile pass: memory rows missing from the `{teamId}:memory` index are
 * re-mirrored, bounded per run. The query is rendered through PgDialect so
 * the join (namespace built from the row's own team, source_id = memory id)
 * and the LIMIT are observed, not assumed.
 */
import { describe, it, expect, spyOn } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  unindexedMemoriesQuery,
  reconcileMemoryIndex,
  MEMORY_RECONCILE_MAX_ROWS,
} from '../memory-index-reconcile';
import type { KnowledgeStore, UpsertChunk } from '../knowledge-store/types';

const dialect = new PgDialect();

const row = (id: string, teamId = 'team-a') => ({
  id, teamId, type: 'gotcha' as const, title: `T ${id}`, content: `C ${id}`,
  project: 'acme/widgets', tags: [], files: [], source: 'dashboard',
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
});

function store(failIds: string[] = []) {
  const upserts: Array<{ ns: string; chunk: UpsertChunk }> = [];
  const ks: KnowledgeStore = {
    async upsert(ns, chunks) {
      for (const c of chunks) {
        if (failIds.includes(c.id)) throw new Error('index down');
        upserts.push({ ns, chunk: c });
      }
      return { inserted: chunks.length, updated: 0, superseded: 0 };
    },
    async query() { return []; },
    async delete() {},
    async listNamespaces() { return []; },
  };
  return { ks, upserts };
}

describe('unindexedMemoriesQuery', () => {
  it('selects rows with no chunk in their own team memory namespace, bounded', () => {
    const q = dialect.sqlToQuery(unindexedMemoriesQuery(7));
    const s = q.sql.replace(/\s+/g, ' ');
    expect(s).toContain('FROM memories m');
    expect(s).toContain('NOT EXISTS');
    expect(s).toContain("kc.namespace = m.team_id::text || ':memory'");
    expect(s).toContain('kc.source_id = m.id::text');
    expect(s).toMatch(/LIMIT \$\d+/);
    expect(q.params).toContain(7);
  });

  it('clamps the limit to the per-run maximum', () => {
    const q = dialect.sqlToQuery(unindexedMemoriesQuery(10_000));
    expect(q.params).toContain(MEMORY_RECONCILE_MAX_ROWS);
    expect(q.params).not.toContain(10_000);
  });
});

describe('reconcileMemoryIndex', () => {
  it('mirrors each missing row into its own team namespace', async () => {
    const { ks, upserts } = store();
    const res = await reconcileMemoryIndex({
      knowledgeStore: ks,
      findUnindexed: async () => [row('m1', 'team-a'), row('m2', 'team-b')],
    });
    expect(res).toEqual({ scanned: 2, mirrored: 2, failed: 0 });
    expect(upserts.map(u => [u.ns, u.chunk.id])).toEqual([
      ['team-a:memory', 'm1'],
      ['team-b:memory', 'm2'],
    ]);
  });

  it('a failing row is counted and does not stop the rest', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { ks, upserts } = store(['m1']);
    const res = await reconcileMemoryIndex({
      knowledgeStore: ks,
      findUnindexed: async () => [row('m1'), row('m2')],
    });
    expect(res).toEqual({ scanned: 2, mirrored: 1, failed: 1 });
    expect(upserts.map(u => u.chunk.id)).toEqual(['m2']);
    warn.mockRestore();
  });

  it('asks for at most the per-run maximum', async () => {
    let asked = 0;
    await reconcileMemoryIndex({
      knowledgeStore: store().ks,
      limit: 999,
      findUnindexed: async (n) => { asked = n; return []; },
    });
    expect(asked).toBe(MEMORY_RECONCILE_MAX_ROWS);
  });
});
