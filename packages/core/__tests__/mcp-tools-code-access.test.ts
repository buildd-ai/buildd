/**
 * The web layer's opt-in GitHub repo check (ctx.codeAccessRefusal) closes the
 * `code` corpus for a person who fails it, on every read path: recall single
 * and multi scope, query_knowledge single and multi corpus. Omitted (API keys,
 * runners), code reads as before. Core never decides access itself.
 */
import { describe, it, expect } from 'bun:test';
import { handleMemoryAction, handleRecallAction } from '../mcp-tools';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

const WS_ID = 'bbbb0000-0000-0000-0000-000000000000';
const TEAM_ID = 'cccc0000-0000-0000-0000-000000000000';

function makeStore(): KnowledgeStore & { queried: string[] } {
  const queried: string[] = [];
  return {
    queried,
    async query(namespace: string): Promise<QueryResult[]> {
      queried.push(namespace);
      return [{
        id: 'src/a.ts#1', namespace, corpus: namespace.split(':')[1] as QueryResult['corpus'],
        sourceType: 'code', sourcePath: 'src/a.ts', sourceUrl: null,
        content: `chunk from ${namespace}`, metadata: {}, score: 0.9,
      }];
    },
    async upsert() {},
    async delete() {},
    async listNamespaces() { return []; },
  };
}

const memClient = { batch: async () => ({ memories: [] }) } as any;
const body = (r: any) => r.content[0].text as string;
const ctxFor = (store: KnowledgeStore, refusal?: () => Promise<string | null>) => ({
  workspaceId: WS_ID, teamId: TEAM_ID, project: 'acme/widgets', knowledgeStore: store, embedder: null as any,
  ...(refusal ? { codeAccessRefusal: refusal } : {}),
});
const refuse = async () => 'Your GitHub account does not have read access to acme/widgets.';

describe('code corpus behind the member repo access check', () => {
  it('no check (API key, runner): recall scope=code reads as before', async () => {
    const store = makeStore();
    const res = await handleRecallAction(memClient, { query: 'thing', scope: 'code' }, ctxFor(store));
    expect(res.isError).toBeFalsy();
    expect(store.queried).toEqual([`${WS_ID}:code`]);
  });

  it('a check that allows reads code', async () => {
    const store = makeStore();
    await handleRecallAction(memClient, { query: 'thing', scope: 'code' }, ctxFor(store, async () => null));
    expect(store.queried).toEqual([`${WS_ID}:code`]);
  });

  it('recall scope=code is refused with the reason', async () => {
    const store = makeStore();
    const res = await handleRecallAction(memClient, { query: 'thing', scope: 'code' }, ctxFor(store, refuse));
    expect(res.isError).toBe(true);
    expect(body(res)).toContain('read access to acme/widgets');
    expect(store.queried).toEqual([]);
  });

  it('multi-scope recall drops code and keeps the rest', async () => {
    const store = makeStore();
    const res = await handleRecallAction(memClient, { query: 'thing', scope: ['docs', 'code'] }, ctxFor(store, refuse));
    expect(store.queried).toEqual([`${WS_ID}:docs`]);
    expect(body(res)).toContain('read access to acme/widgets');
  });

  it('a throwing check fails closed', async () => {
    const store = makeStore();
    const res = await handleRecallAction(memClient, { query: 'thing', scope: 'code' }, ctxFor(store, async () => { throw new Error('github down'); }));
    expect(res.isError).toBe(true);
    expect(store.queried).toEqual([]);
  });

  it('query_knowledge corpus=code is refused too', async () => {
    const store = makeStore();
    await expect(handleMemoryAction(memClient, 'query_knowledge', { query: 'thing', corpus: 'code' }, ctxFor(store, refuse)))
      .rejects.toThrow(/corpus=code is unavailable/);
    expect(store.queried).toEqual([]);
  });

  it('query_knowledge multi-corpus drops code', async () => {
    const store = makeStore();
    await handleMemoryAction(memClient, 'query_knowledge', { query: 'thing', corpus: ['docs', 'code'] }, ctxFor(store, refuse));
    expect(store.queried).toEqual([`${WS_ID}:docs`]);
  });
});
