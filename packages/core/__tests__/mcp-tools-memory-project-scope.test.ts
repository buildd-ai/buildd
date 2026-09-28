/**
 * Invariant: memory surfaced to an agent comes only from the requesting
 * workspace's project key (ctx.project, resolved server-side), never one the
 * caller names, and never team-wide.
 *
 * These assert the requests sent to the memory store and knowledge store —
 * what was asked for — rather than trusting a mocked return to be filtered.
 */
import { describe, it, expect } from 'bun:test';
import { handleMemoryAction, handleRecallAction, handleLearnAction } from '../mcp-tools';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

const WS_ID = 'aaaa0000-0000-0000-0000-000000000000';
const TEAM_ID = 'bbbb0000-0000-0000-0000-000000000001';
const OWN = 'acme/widgets';
const FOREIGN = 'acme/secret-thing';

type Row = { id: string; project: string | null; title?: string; content?: string; type?: string };

/** Records every call; rows are what the table holds for this team. */
function makeMemStore(rows: Row[] = []) {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string, args: unknown[]) => calls.push({ method, args });
  const full = (r: Row) => ({ title: 'T', content: 'C', type: 'gotcha', tags: [], files: [], source: null, ...r });
  return {
    calls,
    called: (method: string) => calls.filter(c => c.method === method),
    async search(params: unknown) { rec('search', [params]); return { results: [], total: 0, limit: 10, offset: 0 }; },
    async getContext(project?: string) { rec('getContext', [project]); return { markdown: '', count: 0 }; },
    async batch(ids: string[]) {
      rec('batch', [ids]);
      return { memories: ids.map(id => rows.find(r => r.id === id)).filter(Boolean).map(r => full(r!)) };
    },
    async get(id: string) {
      rec('get', [id]);
      const r = rows.find(x => x.id === id);
      if (!r) throw new Error(`Memory not found: ${id}`);
      return { memory: full(r) };
    },
    async save(input: any) { rec('save', [input]); return { memory: full({ id: 'new', project: input.project ?? null, ...input }) }; },
    async update(id: string, fields: unknown) { rec('update', [id, fields]); return { memory: full({ id, project: OWN }) }; },
    async delete(id: string) { rec('delete', [id]); return { success: true }; },
  };
}

function makeKnowledgeStore(hits: Array<{ id: string; content: string }>) {
  const queries: { ns: string; topK: number }[] = [];
  const store: KnowledgeStore = {
    async query(ns, opts): Promise<QueryResult[]> {
      queries.push({ ns, topK: opts.topK ?? 0 });
      const corpus = ns.split(':')[1] as any;
      return hits.map(h => ({
        id: h.id,
        namespace: ns,
        corpus,
        sourceType: corpus,
        sourcePath: null,
        sourceUrl: null,
        content: h.content,
        metadata: { memoryId: h.id },
        score: 0.9,
        createdAt: null,
        isCurrent: true,
      }));
    },
    async upsert(_ns, chunks) { return { inserted: chunks.length, updated: 0, superseded: 0 }; },
    async delete() {},
    async listNamespaces() { return []; },
  };
  return { store, queries };
}

const ctxFor = (project: string | undefined, ks?: KnowledgeStore) => ({
  workspaceId: WS_ID,
  teamId: TEAM_ID,
  project,
  knowledgeStore: ks,
  embedder: null as any,
});

// ── buildd_memory search / context ──────────────────────────────────────────

describe('buildd_memory search/context — scoped to the caller project', () => {
  it('search sends the caller project, not a caller-named one', async () => {
    const mc = makeMemStore();
    await handleMemoryAction(mc as any, 'search', { query: 'auth' }, ctxFor(OWN));
    expect(mc.called('search')).toHaveLength(1);
    expect((mc.called('search')[0].args[0] as any).project).toBe(OWN);
  });

  it('search refuses a foreign project and sends nothing to the store', async () => {
    const mc = makeMemStore();
    const res = await handleMemoryAction(mc as any, 'search', { query: 'auth', project: FOREIGN }, ctxFor(OWN));
    expect(res.isError).toBe(true);
    expect(mc.calls).toHaveLength(0);
  });

  it('search accepts another spelling of the caller own project', async () => {
    const mc = makeMemStore();
    const res = await handleMemoryAction(mc as any, 'search', { project: 'https://github.com/Acme/Widgets.git' }, ctxFor(OWN));
    expect(res.isError).toBeFalsy();
    expect((mc.called('search')[0].args[0] as any).project).toBe(OWN);
  });

  it('search with no caller project is refused rather than sent team-wide', async () => {
    const mc = makeMemStore();
    const res = await handleMemoryAction(mc as any, 'search', { query: 'auth', project: FOREIGN }, ctxFor(undefined));
    expect(res.isError).toBe(true);
    expect(mc.calls).toHaveLength(0);
  });

  it('context sends the caller project and refuses a foreign one', async () => {
    const mc = makeMemStore();
    await handleMemoryAction(mc as any, 'context', {}, ctxFor(OWN));
    expect(mc.called('getContext')[0].args[0]).toBe(OWN);

    const mc2 = makeMemStore();
    const res = await handleMemoryAction(mc2 as any, 'context', { project: FOREIGN }, ctxFor(OWN));
    expect(res.isError).toBe(true);
    expect(mc2.calls).toHaveLength(0);
  });

  it('context with no caller project never calls getContext unscoped', async () => {
    const mc = makeMemStore();
    const res = await handleMemoryAction(mc as any, 'context', {}, ctxFor(undefined));
    expect(res.isError).toBe(true);
    expect(mc.called('getContext')).toHaveLength(0);
  });
});

// ── recall scope=memory ─────────────────────────────────────────────────────

describe('recall scope=memory — team namespace narrowed to the caller project', () => {
  const hits = [
    { id: 'own-1', content: 'own lesson' },
    { id: 'foreign-1', content: 'foreign lesson' },
    { id: 'orphan-1', content: 'chunk with no memory row' },
  ];
  const rows: Row[] = [{ id: 'own-1', project: OWN }, { id: 'foreign-1', project: FOREIGN }];

  it('checks every hit against the memories table and drops the foreign ones', async () => {
    const mc = makeMemStore(rows);
    const { store, queries } = makeKnowledgeStore(hits);
    const res = await handleRecallAction(mc as any, { query: 'how do we deploy', scope: 'memory', limit: 5 }, ctxFor(OWN, store));
    expect(queries).toEqual([{ ns: `${TEAM_ID}:memory`, topK: 25 }]);
    expect(mc.called('batch')[0].args[0]).toEqual(['own-1', 'foreign-1', 'orphan-1']);
    const out = res.content[0].text;
    expect(out).toContain('own lesson');
    expect(out).not.toContain('foreign lesson');
    expect(out).not.toContain('chunk with no memory row');
  });

  it('multi-scope recall narrows the memory corpus the same way', async () => {
    const mc = makeMemStore(rows);
    const { store } = makeKnowledgeStore(hits);
    const res = await handleRecallAction(mc as any, { query: 'how do we deploy', scope: ['memory'] }, ctxFor(OWN, store));
    expect(mc.called('batch')).toHaveLength(1);
    expect(res.content[0].text).not.toContain('foreign lesson');
  });

  it('with no caller project, the memory namespace is never queried', async () => {
    const mc = makeMemStore(rows);
    const { store, queries } = makeKnowledgeStore(hits);
    const single = await handleRecallAction(mc as any, { query: 'deploy', scope: 'memory' }, ctxFor(undefined, store));
    expect(single.isError).toBe(true);
    const multi = await handleRecallAction(mc as any, { query: 'deploy', scope: ['memory', 'task'] }, ctxFor(undefined, store));
    expect(multi.content[0].text).toContain('no memory scope');
    expect(queries.map(q => q.ns)).toEqual([`${WS_ID}:task`]);
  });

  it('query_knowledge corpus=memory narrows the same way', async () => {
    const mc = makeMemStore(rows);
    const { store } = makeKnowledgeStore(hits);
    const res = await handleMemoryAction(mc as any, 'query_knowledge', { query: 'deploy', corpus: 'memory' }, ctxFor(OWN, store));
    expect(mc.called('batch')[0].args[0]).toEqual(['own-1', 'foreign-1', 'orphan-1']);
    expect(res.content[0].text).not.toContain('foreign lesson');
  });
});

// ── fetch by id ─────────────────────────────────────────────────────────────

describe('memory fetch by id — project checked, not just team', () => {
  const rows: Row[] = [{ id: 'foreign-1', project: FOREIGN, title: 'Secret', content: 'secret content' }];

  it('recall id refuses a memory from another project without leaking it', async () => {
    const mc = makeMemStore(rows);
    const res = await handleRecallAction(mc as any, { id: 'foreign-1' }, ctxFor(OWN));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Memory not found: foreign-1');
  });

  it('buildd_memory get refuses a memory from another project', async () => {
    const mc = makeMemStore(rows);
    const res = await handleMemoryAction(mc as any, 'get', { id: 'foreign-1' }, ctxFor(OWN));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain('secret content');
  });

  it('recall id refuses a team-wide (no project) memory', async () => {
    const mc = makeMemStore([{ id: 'unscoped', project: null, content: 'unscoped content' }]);
    const res = await handleRecallAction(mc as any, { id: 'unscoped' }, ctxFor(OWN));
    expect(res.isError).toBe(true);
  });

  it('recall id returns the caller own memory', async () => {
    const mc = makeMemStore([{ id: 'own-1', project: OWN, title: 'Mine', content: 'my content' }]);
    const res = await handleRecallAction(mc as any, { id: 'own-1' }, ctxFor(OWN));
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('my content');
  });

  it('update refuses another project memory and never writes', async () => {
    const mc = makeMemStore(rows);
    const res = await handleMemoryAction(mc as any, 'update', { id: 'foreign-1', content: 'x' }, ctxFor(OWN));
    expect(res.isError).toBe(true);
    expect(mc.called('update')).toHaveLength(0);
  });

  it('update refuses moving a memory to another project', async () => {
    const mc = makeMemStore([{ id: 'own-1', project: OWN }]);
    const res = await handleMemoryAction(mc as any, 'update', { id: 'own-1', project: FOREIGN }, ctxFor(OWN));
    expect(res.isError).toBe(true);
    expect(mc.called('update')).toHaveLength(0);
  });
});

// ── writes ──────────────────────────────────────────────────────────────────

describe('memory writes — filed under the caller project only', () => {
  it('learn saves under the caller project', async () => {
    const mc = makeMemStore();
    await handleLearnAction(mc as any, { type: 'gotcha', title: 'T', content: 'C' }, ctxFor(OWN));
    expect((mc.called('save')[0].args[0] as any).project).toBe(OWN);
  });

  it('learn refuses a foreign scope and saves nothing', async () => {
    const mc = makeMemStore();
    const res = await handleLearnAction(mc as any, { type: 'gotcha', title: 'T', content: 'C', scope: FOREIGN }, ctxFor(OWN));
    expect(res.isError).toBe(true);
    expect(mc.called('save')).toHaveLength(0);
  });

  // The dedupe check reads the team-wide namespace too: another project's memory
  // must be neither quoted back as a near-duplicate nor auto-superseded.
  function dedupeStore(similarity: number) {
    const upserts: Array<{ supersedes?: string[] }> = [];
    const nearDupeTopK: number[] = [];
    const { store } = makeKnowledgeStore([]);
    const ks = {
      ...store,
      async upsert(_ns: string, chunks: any[]) {
        for (const c of chunks) upserts.push({ supersedes: c.supersedes });
        return { inserted: chunks.length, updated: 0, superseded: 0 };
      },
      async nearDupeCheck(_ns: string, _content: string, topK?: number) {
        nearDupeTopK.push(topK ?? 0);
        return [{ id: 'foreign-mem', similarity, content: 'FOREIGN SECRET BODY', sourceUrl: null }];
      },
    } as KnowledgeStore;
    return { ks, upserts, nearDupeTopK };
  }

  it('learn does not quote another project memory back as a near-duplicate', async () => {
    const mc = makeMemStore([{ id: 'foreign-mem', project: FOREIGN }]);
    const { ks } = dedupeStore(0.91);
    const res = await handleLearnAction(mc as any, { type: 'gotcha', title: 'T', content: 'C' }, ctxFor(OWN, ks));
    expect(res.content[0].text).not.toContain('FOREIGN SECRET BODY');
    expect(res.content[0].text).not.toContain('foreign-mem');
    expect(mc.called('save')).toHaveLength(1);
  });

  it('learn does not auto-supersede another project memory', async () => {
    const mc = makeMemStore([{ id: 'foreign-mem', project: FOREIGN }]);
    const { ks, upserts, nearDupeTopK } = dedupeStore(0.99);
    await handleLearnAction(mc as any, { type: 'gotcha', title: 'T', content: 'C' }, ctxFor(OWN, ks));
    expect(upserts).toHaveLength(1);
    expect(upserts[0].supersedes).toBeUndefined();
    // Over-fetched so an own-project duplicate is not crowded out.
    expect(nearDupeTopK[0]).toBeGreaterThan(5);
  });

  it('learn still flags an own-project near-duplicate', async () => {
    const mc = makeMemStore([{ id: 'foreign-mem', project: OWN }]);
    const { ks } = dedupeStore(0.91);
    const res = await handleLearnAction(mc as any, { type: 'gotcha', title: 'T', content: 'C' }, ctxFor(OWN, ks));
    expect(res.content[0].text.toLowerCase()).toContain('near-duplicate');
    expect(mc.called('save')).toHaveLength(0);
  });

  it('buildd_memory save refuses a foreign project and saves nothing', async () => {
    const mc = makeMemStore();
    const res = await handleMemoryAction(mc as any, 'save', { type: 'gotcha', title: 'T', content: 'C', project: FOREIGN }, ctxFor(OWN));
    expect(res.isError).toBe(true);
    expect(mc.called('save')).toHaveLength(0);
  });
});
