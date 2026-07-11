/**
 * query_knowledge code/docs corpus → per-workspace namespace
 *
 * Each workspace's code is indexed into {workspaceId}:code and {workspaceId}:docs
 * by the per-workspace ingestion pipeline. query_knowledge must route code/docs
 * lookups to the caller's workspace, not a shared global namespace.
 */
import { describe, it, expect } from 'bun:test';
import { handleMemoryAction } from '../mcp-tools';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

/** Mirrors buildNamespace without importing pg-vector-store (avoids drizzle-orm). */
const ns = (id: string, corpus: string) => `${id}:${corpus}`;

const WS_ID   = 'bbbb0000-0000-0000-0000-000000000000';
const TEAM_ID  = 'cccc0000-0000-0000-0000-000000000000';

function makeQueryRecorder(returnEmpty = false): KnowledgeStore & { queriedNamespaces: string[] } {
  const queriedNamespaces: string[] = [];
  const fakeChunk = (namespace: string): QueryResult => ({
    id: 'src/lib/auth.ts#1',
    namespace,
    corpus: 'code',
    sourceType: 'code',
    sourcePath: 'src/lib/auth.ts',
    sourceUrl: '/src/lib/auth.ts#L1',
    content: 'export function authenticateApiKey() { /* impl */ }',
    metadata: {},
    score: 0.9,
  });

  return {
    queriedNamespaces,
    async query(namespace: string): Promise<QueryResult[]> {
      queriedNamespaces.push(namespace);
      return returnEmpty ? [] : [fakeChunk(namespace)];
    },
    async upsert() {},
    async delete() {},
    async listNamespaces() { return []; },
  };
}

function memCtx(store: KnowledgeStore) {
  return {
    workspaceId: WS_ID,
    teamId: TEAM_ID,
    knowledgeStore: store,
    embedder: null as any,
  };
}

// Minimal no-op MemoryClient (query_knowledge does not call the memory service)
const nullMemClient = {} as any;

describe('query_knowledge code/docs → per-workspace namespace', () => {
  it('code corpus targets the workspace namespace, not a global namespace', async () => {
    const store = makeQueryRecorder();
    await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'authenticateApiKey', corpus: 'code' }, memCtx(store));
    expect(store.queriedNamespaces).toHaveLength(1);
    expect(store.queriedNamespaces[0]).toBe(ns(WS_ID, 'code'));
  });

  it('docs corpus targets the workspace namespace, not a global namespace', async () => {
    const store = makeQueryRecorder();
    await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'release workflow', corpus: 'docs' }, memCtx(store));
    expect(store.queriedNamespaces).toHaveLength(1);
    expect(store.queriedNamespaces[0]).toBe(ns(WS_ID, 'docs'));
  });

  it('memory corpus still uses team-scoped namespace', async () => {
    const store = makeQueryRecorder();
    await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'auth', corpus: 'memory' }, memCtx(store));
    expect(store.queriedNamespaces).toHaveLength(1);
    expect(store.queriedNamespaces[0]).toBe(ns(TEAM_ID, 'memory'));
  });

  it('task corpus still uses workspace-scoped namespace', async () => {
    const store = makeQueryRecorder();
    await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'auth', corpus: 'task' }, memCtx(store));
    expect(store.queriedNamespaces).toHaveLength(1);
    expect(store.queriedNamespaces[0]).toBe(ns(WS_ID, 'task'));
  });

  it('code query returns results with sourceUrl from workspace index', async () => {
    const store = makeQueryRecorder();
    const res = await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'authenticateApiKey', corpus: 'code' }, memCtx(store));
    expect(res.isError).toBeFalsy();
    const out = res.content[0].text;
    expect(out).toContain('authenticateApiKey');
    expect(out).toContain('/src/lib/auth.ts');
  });

  it('empty code namespace returns a message about running ingestion', async () => {
    const store = makeQueryRecorder(true);
    const res = await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'auth', corpus: 'code' }, memCtx(store));
    expect(res.isError).toBeFalsy();
    const out = res.content[0].text;
    expect(out.toLowerCase()).toContain('no code index');
    expect(out.toLowerCase()).toContain('ingestion');
  });

  it('empty docs namespace returns a message about running ingestion', async () => {
    const store = makeQueryRecorder(true);
    const res = await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'api reference', corpus: 'docs' }, memCtx(store));
    expect(res.isError).toBeFalsy();
    const out = res.content[0].text;
    expect(out.toLowerCase()).toContain('no docs index');
    expect(out.toLowerCase()).toContain('ingestion');
  });
});
