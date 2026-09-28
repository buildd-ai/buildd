/**
 * Every core memory read path goes through retrieveMemory: each writes its
 * ledger rows under its own caller name and via, and only pulls count as hits
 * (task d1997424). The golden tests pin that the output did not change; this
 * file pins what the one door added.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleRecallAction, handleMemoryAction, handleBuilddAction, type ActionContext } from '../mcp-tools';
import { buildAuthoringPriorWork } from '../prior-work-render';
import { setDefaultMemoryLedger, type MemoryUseRow, type MemoryLedgerWriter } from '../memory-retrieval';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

// claim_task resolves its project key server-side; every other path here is
// handed its scope explicitly.
mock.module('../memory-scope', () => ({
  resolveMemoryProjectKey: async () => 'acme/widgets',
  resolveMemoryHitScope: async () => null,
}));

const TEAM = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const WORKER = '44444444-4444-4444-8444-444444444444';
const PROJECT = 'acme/widgets';

let batches: MemoryUseRow[][] = [];
let previous: MemoryLedgerWriter;
beforeEach(() => {
  batches = [];
  previous = setDefaultMemoryLedger(rows => { batches.push(rows); });
});
afterEach(() => { setDefaultMemoryLedger(previous); });

function store(byNs: Record<string, Array<Partial<QueryResult> & { id: string }>>) {
  const calls: Array<{ ns: string; trackHits?: boolean }> = [];
  const ks: KnowledgeStore = {
    async query(ns, params) {
      calls.push({ ns, trackHits: params.trackHits });
      const corpus = ns.split(':')[1] as QueryResult['corpus'];
      return (byNs[ns] ?? []).map(r => ({
        namespace: ns, corpus, sourceType: corpus, sourcePath: null, sourceUrl: null,
        content: r.id, metadata: {}, score: 0.8, createdAt: null, isCurrent: true, ...r,
      })) as QueryResult[];
    },
    async upsert() { return { superseded: 0 } as any; },
    async delete() {},
    async listNamespaces() { return []; },
  };
  return { ks, calls };
}

const memClient = { batch: async (ids: string[]) => ({ memories: ids.map(id => ({ id, project: PROJECT })) }) } as any;
const ctx = (ks: KnowledgeStore) => ({ workspaceId: WS, teamId: TEAM, project: PROJECT, workerId: WORKER, knowledgeStore: ks, embedder: null as any });

describe('recall and query_knowledge are pulls', () => {
  it('recall counts hits and ledgers via=pull', async () => {
    const { ks, calls } = store({ [`${TEAM}:memory`]: [{ id: 'm1' }, { id: 'm2' }] });
    await handleRecallAction(memClient, { query: 'how does it work', limit: 2 }, ctx(ks));
    expect(calls).toEqual([{ ns: `${TEAM}:memory`, trackHits: true }]);
    expect(batches).toHaveLength(1);
    expect(batches[0].map(r => [r.memoryId, r.caller, r.via, r.rank, r.workerId, r.teamId])).toEqual([
      ['m1', 'recall', 'pull', 1, WORKER, TEAM],
      ['m2', 'recall', 'pull', 2, WORKER, TEAM],
    ]);
  });

  it('multi-scope recall ledgers only the memory corpus', async () => {
    const { ks } = store({ [`${TEAM}:memory`]: [{ id: 'm1' }], [`${WS}:task`]: [{ id: 't1' }] });
    await handleRecallAction(memClient, { query: 'how does it work', scope: ['memory', 'task'] }, ctx(ks));
    expect(batches.flat().map(r => r.memoryId)).toEqual(['m1']);
  });

  it('query_knowledge ledgers under its own caller name', async () => {
    const { ks, calls } = store({ [`${TEAM}:memory`]: [{ id: 'm1' }] });
    await handleMemoryAction(memClient, 'query_knowledge', { query: 'q', corpus: 'memory' }, ctx(ks));
    expect(calls[0].trackHits).toBe(true);
    expect(batches[0][0]).toMatchObject({ memoryId: 'm1', caller: 'query_knowledge', via: 'pull' });
  });
});

describe('authoring prior work is a push', () => {
  it('memory counts no hit (other corpora still do) and the ledger records which memory hits the merge kept out', async () => {
    const { ks, calls } = store({
      [`${TEAM}:memory`]: [{ id: 'm-top', score: 0.95 }, { id: 'm-low', score: 0.2 }, { id: 'm-capped', score: 0.5 }],
      [`${WS}:task`]: [1, 2, 3, 4].map(i => ({ id: `t${i}`, score: 0.9 })),
    });
    const out = await buildAuthoringPriorWork('q', WS, TEAM, ks, {
      memoryScope: { project: PROJECT, lookup: memClient.batch },
    });
    expect(out.split('\n')).toHaveLength(6);
    expect(calls.filter(c => c.ns.endsWith(':memory')).map(c => c.trackHits)).toEqual([false]);
    expect(calls.filter(c => !c.ns.endsWith(':memory')).every(c => c.trackHits === undefined)).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0].map(r => [r.memoryId, r.caller, r.via, r.gatedBy])).toEqual([
      ['m-top', 'authoring_prior_work', 'push', null],
      ['m-low', 'authoring_prior_work', 'push', 'score_floor'],
      ['m-capped', 'authoring_prior_work', 'push', 'cross_corpus_cap'],
    ]);
  });
});

describe('claim_task reply is a push through the store search', () => {
  it('ledgers the task and worker it was for', async () => {
    const search = mock(async () => ({ results: [{ id: 'mem-1' }], total: 1 }));
    const batch = mock(async () => ({ memories: [{ id: 'mem-1', type: 'gotcha', title: 'T', content: 'c' }] }));
    const api = mock(async (endpoint: string) => endpoint === '/api/workers/claim'
      ? {
          workers: [{
            id: WORKER, taskId: TASK, branch: 'b', openPRs: [],
            task: { id: TASK, title: 'Fix it', workspaceId: WS, workspace: { id: WS, teamId: TEAM, repo: 'https://github.com/acme/widgets', name: 'widgets', dataClass: 'standard' } },
          }],
        }
      : {});
    const actx: ActionContext = {
      workspaceId: WS, authType: 'api',
      getWorkspaceId: async () => WS, getLevel: async () => 'worker',
      getMemoryClient: async () => ({ search, batch }) as any,
    };
    const res = await handleBuilddAction(api as any, 'claim_task', {}, actx);
    expect(res.content[0].text).toContain('## Relevant Memory');
    expect(batches).toEqual([[{
      teamId: TEAM, workspaceId: WS, taskId: TASK, workerId: WORKER, chunkId: null, memoryId: 'mem-1',
      caller: 'claim_task_reply', via: 'push', rank: 1, score: null, gatedBy: null,
    }]]);
  });

  it('a failing ledger never costs the reply its memory', async () => {
    setDefaultMemoryLedger(() => { throw new Error('ledger down'); });
    const search = mock(async () => ({ results: [{ id: 'mem-1' }], total: 1 }));
    const batch = mock(async () => ({ memories: [{ id: 'mem-1', type: 'gotcha', title: 'T', content: 'c' }] }));
    const api = mock(async (endpoint: string) => endpoint === '/api/workers/claim'
      ? { workers: [{ id: WORKER, taskId: TASK, branch: 'b', openPRs: [], task: { id: TASK, title: 'Fix it', workspaceId: WS, workspace: { id: WS, teamId: TEAM, repo: 'https://github.com/acme/widgets', name: 'widgets', dataClass: 'standard' } } }] }
      : {});
    const actx: ActionContext = {
      workspaceId: WS, authType: 'api',
      getWorkspaceId: async () => WS, getLevel: async () => 'worker',
      getMemoryClient: async () => ({ search, batch }) as any,
    };
    const res = await handleBuilddAction(api as any, 'claim_task', {}, actx);
    expect(res.content[0].text).toContain('- **[gotcha] T**: c');
  });
});

describe('deprecated buildd_memory reads go through the door', () => {
  // A store whose search/batch answer from the same rows, recording what was
  // asked. getContext throws: context must not read around retrieveMemory.
  function memStore(rows: Array<{ id: string; title: string; content: string }>) {
    const searches: any[] = [];
    return {
      searches,
      client: {
        async search(p: any) { searches.push(p); return { results: rows.map(r => ({ id: r.id })), total: rows.length }; },
        async batch(ids: string[]) {
          return { memories: ids.map(id => rows.find(r => r.id === id)!).map(r => ({ type: 'gotcha', tags: [], files: [], project: PROJECT, ...r })) };
        },
        async getContext() { throw new Error('context read around retrieveMemory'); },
      } as any,
    };
  }
  const rows = [{ id: 'mem-a', title: 'A', content: 'first' }, { id: 'mem-b', title: 'B', content: 'second' }];
  const mctx = { workspaceId: WS, teamId: TEAM, project: PROJECT, workerId: WORKER, taskId: TASK };

  it('search ledgers one pull row per memory it returned, in rank order', async () => {
    const { client } = memStore(rows);
    const res = await handleMemoryAction(client, 'search', { query: 'first second' }, mctx);
    expect(res.content[0].text).toContain('## gotcha: A');
    expect(batches).toHaveLength(1);
    expect(batches[0].map(r => [r.memoryId, r.caller, r.via, r.rank, r.taskId, r.workerId, r.workspaceId])).toEqual([
      ['mem-a', 'buildd_memory_search', 'pull', 1, TASK, WORKER, WS],
      ['mem-b', 'buildd_memory_search', 'pull', 2, TASK, WORKER, WS],
    ]);
  });

  it('search still searches the caller own project and the states it asked for', async () => {
    const { client, searches } = memStore(rows);
    await handleMemoryAction(client, 'search', { query: 'x', includeCandidates: true, type: 'gotcha', limit: 3 }, mctx);
    expect(searches[0]).toMatchObject({ query: 'x', project: PROJECT, type: 'gotcha', limit: 3, states: ['active', 'candidate'] });
  });

  it('context ledgers what it returned and renders it as before', async () => {
    const { client, searches } = memStore(rows);
    const res = await handleMemoryAction(client, 'context', {}, mctx);
    expect(res.content[0].text).toBe('## [gotcha] A\nfirst\n\n---\n\n## [gotcha] B\nsecond');
    expect(searches[0]).toMatchObject({ project: PROJECT, limit: 20, states: ['active'] });
    expect(searches[0].query).toBeUndefined();
    expect(batches[0].map(r => [r.memoryId, r.caller, r.via, r.rank])).toEqual([
      ['mem-a', 'buildd_memory_context', 'pull', 1],
      ['mem-b', 'buildd_memory_context', 'pull', 2],
    ]);
  });

  it('an empty context writes no ledger rows', async () => {
    const { client } = memStore([]);
    const res = await handleMemoryAction(client, 'context', {}, mctx);
    expect(res.content[0].text).toBe('(No memories yet)');
    expect(batches).toEqual([]);
  });
});
