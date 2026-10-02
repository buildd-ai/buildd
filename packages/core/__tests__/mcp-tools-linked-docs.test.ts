/**
 * Linked knowledge workspaces: docs recall reads the caller's own docs corpus
 * plus the docs corpus of each workspace the web layer resolved as linked
 * (`ctx.linkedDocsWorkspaceIds`). Core receives already-authorised ids; only
 * the docs corpus widens, never code/task/memory.
 */
import { describe, it, expect } from 'bun:test';
import { handleMemoryAction, handleRecallAction } from '../mcp-tools';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

const ns = (id: string, corpus: string) => `${id}:${corpus}`;

const WS_ID = 'bbbb0000-0000-0000-0000-000000000000';
const LINKED_ID = 'dddd0000-0000-0000-0000-000000000000';
const OTHER_ID = 'eeee0000-0000-0000-0000-000000000000';
const TEAM_ID = 'cccc0000-0000-0000-0000-000000000000';
const PROJECT = 'acme/widgets';

function makeStore(failFor: string[] = []): KnowledgeStore & { queried: string[] } {
  const queried: string[] = [];
  const chunk = (namespace: string, corpus: string): QueryResult => ({
    id: 'docs/strategy.md#1',
    namespace,
    corpus: corpus as QueryResult['corpus'],
    sourceType: 'docs',
    sourcePath: 'docs/strategy.md',
    sourceUrl: null,
    content: `strategy chunk from ${namespace}`,
    metadata: {},
    score: 0.9,
  });
  return {
    queried,
    async query(namespace: string): Promise<QueryResult[]> {
      queried.push(namespace);
      if (failFor.includes(namespace)) throw new Error('boom');
      return [chunk(namespace, namespace.split(':')[1])];
    },
    async upsert() {},
    async delete() {},
    async listNamespaces() { return []; },
  };
}

const ctxFor = (store: KnowledgeStore, linked?: string[]) => ({
  workspaceId: WS_ID,
  teamId: TEAM_ID,
  project: PROJECT,
  knowledgeStore: store,
  embedder: null as any,
  ...(linked ? { linkedDocsWorkspaceIds: linked } : {}),
});

const memClient = { batch: async () => ({ memories: [] }) } as any;
const body = (r: any) => r.content[0].text as string;

describe('linked docs — recall', () => {
  it('single docs scope returns a chunk from the linked workspace', async () => {
    const store = makeStore();
    const res = await handleRecallAction(memClient, { query: 'strategy', scope: 'docs' }, ctxFor(store, [LINKED_ID]));
    expect(store.queried).toContain(ns(WS_ID, 'docs'));
    expect(store.queried).toContain(ns(LINKED_ID, 'docs'));
    expect(body(res)).toContain(`strategy chunk from ${ns(LINKED_ID, 'docs')}`);
    expect(body(res)).toContain(`strategy chunk from ${ns(WS_ID, 'docs')}`);
  });

  it('multi-scope docs includes the linked workspace and keeps same-id chunks distinct', async () => {
    const store = makeStore();
    const res = await handleRecallAction(memClient, { query: 'strategy', scope: ['docs', 'code'] }, ctxFor(store, [LINKED_ID]));
    expect(store.queried).toContain(ns(LINKED_ID, 'docs'));
    expect(store.queried).not.toContain(ns(LINKED_ID, 'code'));
    expect(body(res)).toContain(`strategy chunk from ${ns(LINKED_ID, 'docs')}`);
    expect(body(res)).toContain(`strategy chunk from ${ns(WS_ID, 'docs')}`);
  });

  it('no linked ids: only the own docs namespace is queried', async () => {
    const store = makeStore();
    await handleRecallAction(memClient, { query: 'strategy', scope: 'docs' }, ctxFor(store));
    expect(store.queried).toEqual([ns(WS_ID, 'docs')]);
  });

  it('a workspace that is not in the linked list is never queried', async () => {
    const store = makeStore();
    await handleRecallAction(memClient, { query: 'strategy', scope: 'docs' }, ctxFor(store, [LINKED_ID]));
    expect(store.queried).not.toContain(ns(OTHER_ID, 'docs'));
  });

  it('non-docs corpora never widen to linked workspaces', async () => {
    const store = makeStore();
    await handleRecallAction(memClient, { query: 'strategy', scope: 'code' }, ctxFor(store, [LINKED_ID]));
    await handleRecallAction(memClient, { query: 'strategy', scope: 'task' }, ctxFor(store, [LINKED_ID]));
    expect(store.queried.every(n => n.startsWith(`${WS_ID}:`))).toBe(true);
  });

  it('a failing linked workspace does not fail the recall', async () => {
    const store = makeStore([ns(LINKED_ID, 'docs')]);
    const res = await handleRecallAction(memClient, { query: 'strategy', scope: 'docs' }, ctxFor(store, [LINKED_ID]));
    expect(res.isError).toBeFalsy();
    expect(body(res)).toContain(`strategy chunk from ${ns(WS_ID, 'docs')}`);
  });

  it('own docs failure still surfaces', async () => {
    const store = makeStore([ns(WS_ID, 'docs')]);
    await expect(
      handleRecallAction(memClient, { query: 'strategy', scope: 'docs' }, ctxFor(store, [LINKED_ID])),
    ).rejects.toThrow();
  });
});

describe('linked docs — query_knowledge', () => {
  it('single docs corpus reads the linked workspace', async () => {
    const store = makeStore();
    const res = await handleMemoryAction(memClient, 'query_knowledge', { query: 'strategy', corpus: 'docs' }, ctxFor(store, [LINKED_ID]));
    expect(body(res)).toContain(`strategy chunk from ${ns(LINKED_ID, 'docs')}`);
  });

  it('multi corpus reads the linked workspace docs only', async () => {
    const store = makeStore();
    const res = await handleMemoryAction(memClient, 'query_knowledge', { query: 'strategy', corpus: ['docs', 'code'] }, ctxFor(store, [LINKED_ID]));
    expect(body(res)).toContain(`strategy chunk from ${ns(LINKED_ID, 'docs')}`);
    expect(store.queried).not.toContain(ns(LINKED_ID, 'code'));
  });

  it('without linked ids a docs query stays on the own namespace', async () => {
    const store = makeStore();
    await handleMemoryAction(memClient, 'query_knowledge', { query: 'strategy', corpus: 'docs' }, ctxFor(store));
    expect(store.queried).toEqual([ns(WS_ID, 'docs')]);
  });
});
