/**
 * retrieveMemory: the one door every memory read goes through, and the
 * memory_uses ledger it writes (task d1997424).
 */
import { describe, it, expect } from 'bun:test';
import {
  retrieveMemory,
  buildMemoryUseRows,
  dbMemoryLedger,
  createDbMemoryLedger,
  MEMORY_CALLER_VIA,
  type MemoryUseRow,
  type MemoryCaller,
} from '../memory-retrieval';
import type { MemoryHitScope, MemoryQuerier } from '../memory-hit-scope';
import type { QueryResult } from '../knowledge-store/types';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const WORKER = '44444444-4444-4444-8444-444444444444';
const OWN = 'acme/widgets';

function scope(foreign: string[] = []): MemoryHitScope {
  return {
    project: OWN,
    lookup: async (ids) => ({ memories: ids.map(id => ({ id, project: foreign.includes(id) ? 'acme/other' : OWN })) }),
  };
}

function store(rows: Array<Partial<QueryResult> & { id: string }>) {
  const calls: Array<{ ns: string; params: Record<string, unknown> }> = [];
  const ks: MemoryQuerier = {
    async query(ns, params) {
      calls.push({ ns, params: { ...params } });
      return rows.map(r => ({
        namespace: ns, corpus: 'memory', sourceType: 'memory', sourcePath: null, sourceUrl: null,
        content: r.id, metadata: {}, score: 0.5, createdAt: null, isCurrent: true, ...r,
      })) as QueryResult[];
    },
  };
  return { ks, calls };
}

function ledger() {
  const batches: MemoryUseRow[][] = [];
  return { batches, write: (rows: MemoryUseRow[]) => { batches.push(rows); } };
}

const ROWS = [
  { id: 'm1', score: 0.9 },
  { id: 'm-foreign', score: 0.85 },
  { id: 'm2', score: 0.4, isCurrent: false },
  { id: 'm3', score: 0.3 },
];

describe('retrieveMemory (hybrid)', () => {
  it('queries the team memory namespace over-fetched and narrows to the own project', async () => {
    const { ks, calls } = store(ROWS);
    const l = ledger();
    const res = await retrieveMemory({
      query: 'q', scope: { teamId: TEAM, workspaceId: WS, memoryScope: scope(['m-foreign']) },
      caller: 'claim_context', budget: { topK: 2 }, store: ks, ledger: l.write,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].ns).toBe(`${TEAM}:memory`);
    expect(calls[0].params.topK).toBe(10);
    expect(res.results.map(r => r.id)).toEqual(['m1', 'm2']);
    expect(res.hits.map(h => [h.memoryId, h.rank])).toEqual([['m1', 1], ['m2', 2]]);
  });

  it('counts only pulls as hits: pushes pass trackHits false, pulls true', async () => {
    for (const caller of Object.keys(MEMORY_CALLER_VIA) as MemoryCaller[]) {
      const { ks, calls } = store(ROWS);
      await retrieveMemory({ query: 'q', scope: { teamId: TEAM, memoryScope: scope() }, caller, budget: { topK: 1 }, store: ks, ledger: false });
      expect(calls[0].params.trackHits).toBe(MEMORY_CALLER_VIA[caller] === 'pull');
    }
    expect(MEMORY_CALLER_VIA.recall).toBe('pull');
    expect(MEMORY_CALLER_VIA.claim_context).toBe('push');
  });

  it('a null scope means no query and no ledger', async () => {
    const { ks, calls } = store(ROWS);
    const l = ledger();
    const res = await retrieveMemory({ query: 'q', scope: { teamId: TEAM, memoryScope: null }, caller: 'recall', budget: { topK: 3 }, store: ks, ledger: l.write });
    expect(res.results).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(l.batches).toHaveLength(0);
  });

  it('no team id means no query', async () => {
    const { ks, calls } = store(ROWS);
    await retrieveMemory({ query: 'q', scope: { teamId: null, memoryScope: scope() }, caller: 'recall', budget: { topK: 3 }, store: ks, ledger: false });
    expect(calls).toHaveLength(0);
  });

  it('excludeSuperseded drops isCurrent=false before narrowing; filter applies before the cut', async () => {
    const { ks } = store(ROWS);
    const res = await retrieveMemory({
      query: 'q', scope: { teamId: TEAM, memoryScope: scope() }, caller: 'recall',
      budget: { topK: 1, candidates: 5 }, store: ks, ledger: false,
      excludeSuperseded: true, filter: r => r.id !== 'm1',
    });
    expect(res.results.map(r => r.id)).toEqual(['m-foreign']);
  });

  it('gated hits are returned flagged, left out of results, and ledgered with the rule', async () => {
    const { ks } = store(ROWS);
    const l = ledger();
    const res = await retrieveMemory({
      query: 'q', scope: { teamId: TEAM, workspaceId: WS, memoryScope: scope(['m-foreign']) },
      caller: 'claim_context', budget: { topK: 3 }, store: ks, ledger: l.write,
      gate: { minScore: 0.45, exclude: new Set(['m1']) },
      attribution: { taskId: TASK, workerId: WORKER },
    });
    expect(res.results).toEqual([]);
    expect(res.hits.map(h => [h.memoryId, h.gatedBy])).toEqual([['m1', 'excluded'], ['m2', 'score_floor'], ['m3', 'score_floor']]);
    expect(l.batches).toHaveLength(1);
    expect(l.batches[0]).toEqual([
      { teamId: TEAM, workspaceId: WS, taskId: TASK, workerId: WORKER, chunkId: 'm1', memoryId: 'm1', caller: 'claim_context', via: 'push', rank: 1, score: 0.9, gatedBy: 'excluded' },
      { teamId: TEAM, workspaceId: WS, taskId: TASK, workerId: WORKER, chunkId: 'm2', memoryId: 'm2', caller: 'claim_context', via: 'push', rank: 2, score: 0.4, gatedBy: 'score_floor' },
      { teamId: TEAM, workspaceId: WS, taskId: TASK, workerId: WORKER, chunkId: 'm3', memoryId: 'm3', caller: 'claim_context', via: 'push', rank: 3, score: 0.3, gatedBy: 'score_floor' },
    ]);
  });

  it('memoryId comes from chunk metadata when present', async () => {
    const { ks } = store([{ id: 'chunk-a', metadata: { memoryId: 'mem-a' } }]);
    const res = await retrieveMemory({
      query: 'q', scope: { teamId: TEAM, memoryScope: { project: OWN, lookup: async ids => ({ memories: ids.map(id => ({ id, project: OWN })) }) } },
      caller: 'recall', budget: { topK: 1 }, store: ks, ledger: false,
    });
    expect(res.hits[0]).toMatchObject({ chunkId: 'chunk-a', memoryId: 'mem-a' });
  });

  it('deferLedger waits for commitLedger, applies the extra gate, and writes once', async () => {
    const { ks } = store(ROWS);
    const l = ledger();
    const res = await retrieveMemory({
      query: 'q', scope: { teamId: TEAM, memoryScope: scope() }, caller: 'authoring_prior_work',
      budget: { topK: 2 }, store: ks, ledger: l.write, deferLedger: true,
    });
    expect(l.batches).toHaveLength(0);
    res.commitLedger(h => (h.memoryId === 'm-foreign' ? 'cross_corpus_cap' : null));
    res.commitLedger();
    expect(l.batches).toHaveLength(1);
    expect(l.batches[0].map(r => [r.memoryId, r.gatedBy])).toEqual([['m1', null], ['m-foreign', 'cross_corpus_cap']]);
  });

  it('a throwing ledger writer never fails the read', async () => {
    const { ks } = store(ROWS);
    const res = await retrieveMemory({
      query: 'q', scope: { teamId: TEAM, memoryScope: scope() }, caller: 'recall', budget: { topK: 1 }, store: ks,
      ledger: () => { throw new Error('ledger down'); },
    });
    expect(res.results.map(r => r.id)).toEqual(['m1']);
  });

  it("onError 'empty' swallows a store failure; 'throw' propagates it", async () => {
    const ks: MemoryQuerier = { query: async () => { throw new Error('store down'); } };
    const base = { query: 'q', scope: { teamId: TEAM, memoryScope: scope() }, caller: 'recall' as const, budget: { topK: 1 }, store: ks, ledger: false as const };
    expect((await retrieveMemory(base)).results).toEqual([]);
    await expect(retrieveMemory({ ...base, onError: 'throw' })).rejects.toThrow('store down');
  });
});

describe('retrieveMemory (store-search)', () => {
  function searcher(ids: string[], rows: Array<{ id: string; title: string }>) {
    const searches: unknown[] = [];
    const batches: string[][] = [];
    return {
      searches, batches,
      s: {
        search: async (p: unknown) => { searches.push(p); return { results: ids.map(id => ({ id })), total: 42 }; },
        batch: async (b: string[]) => { batches.push(b); return { memories: rows }; },
      },
    };
  }

  it('passes the search params through verbatim and returns rows in batch order', async () => {
    const { s, searches, batches } = searcher(['a', 'b'], [{ id: 'b', title: 'B' }, { id: 'a', title: 'A' }]);
    const l = ledger();
    const res = await retrieveMemory({
      strategy: 'store-search', searcher: s, search: { query: 'fix', project: OWN, limit: 5 },
      scope: { teamId: TEAM, workspaceId: WS }, caller: 'claim_task_reply',
      attribution: { taskId: TASK, workerId: 'not-a-uuid' }, ledger: l.write,
    });
    expect(searches).toEqual([{ query: 'fix', project: OWN, limit: 5 }]);
    expect(batches).toEqual([['a', 'b']]);
    expect(res.memories.map((m: any) => m.id)).toEqual(['b', 'a']);
    expect(res.total).toBe(42);
    expect(l.batches[0]).toEqual([
      { teamId: TEAM, workspaceId: WS, taskId: TASK, workerId: null, chunkId: null, memoryId: 'a', caller: 'claim_task_reply', via: 'push', rank: 1, score: null, gatedBy: null },
      { teamId: TEAM, workspaceId: WS, taskId: TASK, workerId: null, chunkId: null, memoryId: 'b', caller: 'claim_task_reply', via: 'push', rank: 2, score: null, gatedBy: null },
    ]);
  });

  it('an empty search skips the batch and the ledger', async () => {
    const { s, batches } = searcher([], []);
    const l = ledger();
    const res = await retrieveMemory({ strategy: 'store-search', searcher: s, search: { query: 'x' }, scope: { teamId: TEAM }, caller: 'runner_workspace_memory', ledger: l.write });
    expect(res).toEqual({ memories: [], total: 0, hits: [] });
    expect(batches).toHaveLength(0);
    expect(l.batches).toHaveLength(0);
  });
});

describe('ledger rows', () => {
  it('writes nothing when the team id is not a UUID', () => {
    expect(buildMemoryUseRows({
      hits: [{ chunkId: 'c', memoryId: 'm', rank: 1, score: 1, gated: false, gatedBy: null }],
      teamId: 'team-1', caller: 'recall',
    })).toEqual([]);
  });

  const ROW: MemoryUseRow = {
    teamId: TEAM, workspaceId: null, taskId: null, workerId: null, chunkId: null, memoryId: 'm',
    caller: 'recall', via: 'pull', rank: 1, score: null, gatedBy: null,
  };

  it('the DB writer sends one INSERT per batch and swallows a failure', async () => {
    const inserted: unknown[] = [];
    const write = createDbMemoryLedger(async () => ({
      table: 'memory_uses',
      db: { insert: (t: unknown) => ({ values: async (rows: unknown) => { inserted.push([t, rows]); } }) },
    }));
    write([ROW, { ...ROW, rank: 2 }]);
    write([]);
    await new Promise(r => setTimeout(r, 0));
    expect(inserted).toEqual([['memory_uses', [ROW, { ...ROW, rank: 2 }]]]);

    const failing = createDbMemoryLedger(async () => { throw new Error('DATABASE_URL is required'); });
    expect(() => failing([ROW])).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
  });

  it('the default writer is inert under bun test, so no test can write to a live database', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => dbMemoryLedger([ROW])).not.toThrow();
  });
});
