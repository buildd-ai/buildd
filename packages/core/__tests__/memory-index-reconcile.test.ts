/**
 * Reconcile pass: brings the `{teamId}:memory` index back in line with the
 * memories table, bounded per run.
 *
 * - a row with no chunk is mirrored; a row whose chunk is stale (content,
 *   title, project, type, tags or files differ) is re-mirrored;
 * - a row recorded as superseded is never indexed as current;
 * - rows with no project, and rows under a key a sensitive workspace in the
 *   team resolves to, are left alone;
 * - a row that keeps failing sinks behind fresh ones and drops out after a
 *   capped number of attempts, so it cannot block the backlog.
 *
 * The query is rendered through PgDialect so these conditions are observed in
 * the SQL, not assumed.
 */
import { describe, it, expect, spyOn } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  reconcileCandidatesQuery,
  reconcileMemoryIndex,
  sensitiveMemoryKeys,
  MEMORY_RECONCILE_MAX_ROWS,
  MEMORY_RECONCILE_MAX_ATTEMPTS,
  type ReconcileCandidate,
  type ReconcileDeps,
} from '../memory-index-reconcile';
import type { KnowledgeStore, UpsertChunk } from '../knowledge-store/types';

const dialect = new PgDialect();
const render = (limit: number, excluded: Array<{ teamId: string; project: string }> = []) => {
  const q = dialect.sqlToQuery(reconcileCandidatesQuery(limit, excluded));
  return { sql: q.sql.replace(/\s+/g, ' '), params: q.params };
};

const row = (id: string, over: Partial<ReconcileCandidate> = {}): ReconcileCandidate => ({
  id, teamId: 'team-a', type: 'gotcha', title: `T ${id}`, content: `C ${id}`,
  project: 'acme/widgets', tags: [], files: [],
  supersededBy: null, indexFailures: 0, chunkState: 'missing', ...over,
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

function deps(candidates: ReconcileCandidate[]) {
  const flipped: Array<{ teamId: string; id: string; by: string }> = [];
  const outcomes: Array<{ id: string; ok: boolean }> = [];
  let asked = 0;
  const d: ReconcileDeps = {
    findCandidates: async (n) => { asked = n; return candidates; },
    markChunkSuperseded: async (teamId, id, by) => { flipped.push({ teamId, id, by }); },
    recordOutcome: async (id, ok) => { outcomes.push({ id, ok }); },
  };
  return { d, flipped, outcomes, asked: () => asked };
}

describe('reconcileCandidatesQuery', () => {
  it('joins each row to the chunk in its own team namespace by memory id', () => {
    const { sql } = render(7);
    expect(sql).toContain('FROM memories m');
    expect(sql).toContain("kc.namespace = m.team_id::text || ':memory'");
    expect(sql).toContain('kc.source_id = m.id::text');
  });

  it('selects missing, stale and superseded-but-current chunks', () => {
    const { sql } = render(7);
    expect(sql).toContain('kc.id IS NULL');
    expect(sql).toContain('kc.content IS DISTINCT FROM m.content');
    expect(sql).toContain("kc.metadata->>'project' IS DISTINCT FROM m.project");
    expect(sql).toContain('m.superseded_by IS NOT NULL AND kc.is_current');
  });

  it('skips projectless rows and rows past the attempt cap, lowest failures first', () => {
    const { sql, params } = render(7);
    expect(sql).toContain('m.project IS NOT NULL');
    expect(sql).toMatch(/m\.index_failures < \$\d+/);
    expect(params).toContain(MEMORY_RECONCILE_MAX_ATTEMPTS);
    expect(sql).toMatch(/ORDER BY m\.index_failures ASC, m\.updated_at DESC/);
  });

  it('excludes (team, key) pairs a sensitive workspace resolves to', () => {
    const { sql, params } = render(7, [{ teamId: 'team-a', project: 'acme/secret-thing' }]);
    expect(sql).toMatch(/\(m\.team_id::text, m\.project\) NOT IN \(\(\$\d+, \$\d+\)\)/);
    expect(params).toContain('acme/secret-thing');
  });

  it('bounds the limit to the per-run maximum', () => {
    expect(render(7).params).toContain(7);
    const big = render(10_000);
    expect(big.params).toContain(MEMORY_RECONCILE_MAX_ROWS);
    expect(big.params).not.toContain(10_000);
  });
});

describe('sensitiveMemoryKeys', () => {
  it('maps each sensitive workspace to its canonical key in its team', () => {
    expect(sensitiveMemoryKeys([
      { teamId: 'team-a', repo: 'https://github.com/Acme/Secret-Thing.git', name: 'secret' },
      { teamId: 'team-b', repo: null, name: '' },
    ])).toEqual([{ teamId: 'team-a', project: 'acme/secret-thing' }]);
  });
});

describe('reconcileMemoryIndex', () => {
  it('mirrors missing and stale rows into their own team namespace', async () => {
    const { ks, upserts } = store();
    const { d } = deps([row('m1', { teamId: 'team-a' }), row('m2', { teamId: 'team-b', chunkState: 'stale', content: 'redacted' })]);
    const res = await reconcileMemoryIndex({ knowledgeStore: ks, deps: d });
    expect(res).toEqual({ scanned: 2, mirrored: 2, superseded: 0, failed: 0 });
    expect(upserts.map(u => [u.ns, u.chunk.id, u.chunk.content])).toEqual([
      ['team-a:memory', 'm1', 'C m1'],
      ['team-b:memory', 'm2', 'redacted'],
    ]);
  });

  it('a superseded row is indexed as not current, never resurrected', async () => {
    const { ks, upserts } = store();
    const { d, flipped } = deps([row('old', { supersededBy: 'new', chunkState: 'missing' })]);
    const res = await reconcileMemoryIndex({ knowledgeStore: ks, deps: d });
    expect(upserts.map(u => u.chunk.id)).toEqual(['old']);
    expect(flipped).toEqual([{ teamId: 'team-a', id: 'old', by: 'new' }]);
    expect(res.superseded).toBe(1);
  });

  it('a current chunk for a superseded row is flipped without re-embedding', async () => {
    const { ks, upserts } = store();
    const { d, flipped } = deps([row('old', { supersededBy: 'new', chunkState: 'superseded' })]);
    await reconcileMemoryIndex({ knowledgeStore: ks, deps: d });
    expect(upserts).toHaveLength(0);
    expect(flipped).toEqual([{ teamId: 'team-a', id: 'old', by: 'new' }]);
  });

  it('a failing row is recorded as a failed attempt and does not stop the rest', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { ks, upserts } = store(['m1']);
    const { d, outcomes } = deps([row('m1'), row('m2', { indexFailures: 2 })]);
    const res = await reconcileMemoryIndex({ knowledgeStore: ks, deps: d });
    expect(res).toEqual({ scanned: 2, mirrored: 1, superseded: 0, failed: 1 });
    expect(upserts.map(u => u.chunk.id)).toEqual(['m2']);
    // m1 counts a failure; m2 had failures before and is reset on success.
    expect(outcomes).toEqual([{ id: 'm1', ok: false }, { id: 'm2', ok: true }]);
    warn.mockRestore();
  });

  it('a row that never failed writes no outcome on success', async () => {
    const { d, outcomes } = deps([row('m1')]);
    await reconcileMemoryIndex({ knowledgeStore: store().ks, deps: d });
    expect(outcomes).toEqual([]);
  });

  it('asks for at most the per-run maximum', async () => {
    const { d, asked } = deps([]);
    await reconcileMemoryIndex({ knowledgeStore: store().ks, limit: 999, deps: d });
    expect(asked()).toBe(MEMORY_RECONCILE_MAX_ROWS);
  });
});
