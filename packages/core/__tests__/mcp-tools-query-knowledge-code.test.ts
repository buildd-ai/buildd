/**
 * query_knowledge code/docs corpus → spec-sync namespace
 *
 * The spec-sync pipeline indexes the repo under SPEC_SYNC_NAMESPACE:code and
 * SPEC_SYNC_NAMESPACE:docs. These are the same namespaces spec_compare reads.
 * query_knowledge must redirect code/docs lookups there instead of the
 * workspace-scoped {workspaceId}:code/docs namespaces (which are empty).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { handleMemoryAction } from '../mcp-tools';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

/** Mirrors buildNamespace without importing pg-vector-store (avoids drizzle-orm). */
const ns = (id: string, corpus: string) => `${id}:${corpus}`;

const SPEC_NS = 'aaaa0000-0000-0000-0000-000000000000';
const WS_ID   = 'bbbb0000-0000-0000-0000-000000000000';
const TEAM_ID  = 'cccc0000-0000-0000-0000-000000000000';
const DEFAULT_SPEC_NS = '471effe1-4668-4cc9-9fa3-e20a56769deb';

function makeQueryRecorder(): KnowledgeStore & { queriedNamespaces: string[] } {
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
      return [fakeChunk(namespace)];
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

const savedEnv = process.env.SPEC_SYNC_NAMESPACE;

describe('query_knowledge code/docs → spec-sync namespace', () => {
  beforeAll(() => {
    process.env.SPEC_SYNC_NAMESPACE = SPEC_NS;
  });

  afterAll(() => {
    if (savedEnv !== undefined) {
      process.env.SPEC_SYNC_NAMESPACE = savedEnv;
    } else {
      delete process.env.SPEC_SYNC_NAMESPACE;
    }
  });

  it('code corpus targets the spec-sync namespace, not the workspace namespace', async () => {
    const store = makeQueryRecorder();
    await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'authenticateApiKey', corpus: 'code' }, memCtx(store));
    expect(store.queriedNamespaces).toHaveLength(1);
    expect(store.queriedNamespaces[0]).toBe(ns(SPEC_NS, 'code'));
    expect(store.queriedNamespaces[0]).not.toContain(WS_ID);
  });

  it('docs corpus targets the spec-sync namespace, not the workspace namespace', async () => {
    const store = makeQueryRecorder();
    await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'release workflow', corpus: 'docs' }, memCtx(store));
    expect(store.queriedNamespaces).toHaveLength(1);
    expect(store.queriedNamespaces[0]).toBe(ns(SPEC_NS, 'docs'));
    expect(store.queriedNamespaces[0]).not.toContain(WS_ID);
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

  it('code query returns results with sourceUrl from spec-sync index', async () => {
    const store = makeQueryRecorder();
    const res = await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'authenticateApiKey', corpus: 'code' }, memCtx(store));
    expect(res.isError).toBeFalsy();
    const out = res.content[0].text;
    expect(out).toContain('authenticateApiKey');
    expect(out).toContain('/src/lib/auth.ts');
  });

  it('falls back to the hardcoded default when SPEC_SYNC_NAMESPACE is unset', async () => {
    const prev = process.env.SPEC_SYNC_NAMESPACE;
    delete process.env.SPEC_SYNC_NAMESPACE;
    try {
      const store = makeQueryRecorder();
      await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'auth', corpus: 'code' }, memCtx(store));
      expect(store.queriedNamespaces[0]).toBe(ns(DEFAULT_SPEC_NS, 'code'));
    } finally {
      if (prev !== undefined) process.env.SPEC_SYNC_NAMESPACE = prev;
      else process.env.SPEC_SYNC_NAMESPACE = SPEC_NS; // restore for subsequent tests
    }
  });
});
