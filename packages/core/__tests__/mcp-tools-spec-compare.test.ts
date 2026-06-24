import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, handleMemoryAction, type ApiFn, type ActionContext } from '../mcp-tools';
import { MemoryClient } from '../memory-client';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

const WS_ID = 'ws-1';
const noopApi = (async () => ({})) as unknown as ApiFn;

// Mock store: code side returns the *missions* table (a semantic neighbour of
// "objectives"), spec side returns a full objectives page — the exact shape that
// fools a score gate but that a judge resolves from the snippets.
function mockStore(): KnowledgeStore {
  return {
    async query(namespace: string): Promise<QueryResult[]> {
      const isCode = namespace.endsWith(':code');
      const base = { namespace, corpus: (isCode ? 'code' : 'spec') as any, sourceUrl: null, metadata: {} };
      return isCode
        ? [{ ...base, id: 'c1', sourceType: 'code', sourcePath: 'core/db/schema.ts', content: "export const missions = pgTable('missions', { ... })", score: 0.445 }]
        : [{ ...base, id: 's1', sourceType: 'spec', sourcePath: 'content/docs/features/objectives.mdx', content: 'Objectives track goals and link tasks...', score: 0.75 }];
    },
    async upsert() {}, async delete() {}, async deleteBySource() {}, async listNamespaces() { return []; },
  } as unknown as KnowledgeStore;
}

function adminCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => 'admin',
    knowledgeStore: mockStore(),
    ...overrides,
  };
}

describe('spec_compare', () => {
  it('rejects non-admin tokens', async () => {
    const err = await handleBuilddAction(noopApi, 'spec_compare', { feature: 'objectives' }, {
      workspaceId: WS_ID, getWorkspaceId: async () => WS_ID, getLevel: async () => 'worker',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('admin');
  });

  it('requires a feature/query', async () => {
    const err = await handleBuilddAction(noopApi, 'spec_compare', {}, adminCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/feature|query/i);
  });

  it('requires a workspaceId', async () => {
    const err = await handleBuilddAction(noopApi, 'spec_compare', { feature: 'objectives' }, {
      ...adminCtx(),
      workspaceId: undefined,
      getWorkspaceId: async () => null,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/workspaceId/i);
  });

  it('queries unified workspace store using {workspaceId}:code and {workspaceId}:spec', async () => {
    const queried: string[] = [];
    const trackingStore: KnowledgeStore = {
      async query(namespace: string): Promise<QueryResult[]> {
        queried.push(namespace);
        return mockStore().query(namespace);
      },
      async upsert() {}, async delete() {}, async deleteBySource() {}, async listNamespaces() { return []; },
    } as unknown as KnowledgeStore;

    await handleBuilddAction(noopApi, 'spec_compare', { feature: 'objectives' }, adminCtx({ knowledgeStore: trackingStore }));
    expect(queried).toContain(`${WS_ID}:code`);
    expect(queried).toContain(`${WS_ID}:spec`);
  });

  it('returns both code and spec evidence with judge framing (scores surface, judge decides)', async () => {
    const res = await handleBuilddAction(noopApi, 'spec_compare', { feature: 'objectives' }, adminCtx());
    const out = res.content[0].text;
    // both sides present
    expect(out).toContain('schema.ts');
    expect(out).toContain('objectives.mdx');
    expect(out).toContain('0.445');
    expect(out).toContain('0.75');
    // explicitly frames the judge step and warns scores are not a verdict
    expect(out).toMatch(/judge|verdict|implement/i);
    // headings reflect unified store labels
    expect(out).toContain('CODE evidence');
    expect(out).toContain('SPEC evidence');
    expect(res.isError).toBeFalsy();
  });
});

describe('query_knowledge — worker token access', () => {
  it('worker token can call query_knowledge with corpus=code without auth error', async () => {
    const ks = mockStore();
    const memClient = { getContext: async () => ({ markdown: '' }), search: async () => ({ memories: [] }) } as unknown as MemoryClient;
    const res = await handleMemoryAction(memClient, 'query_knowledge', { query: 'schema', corpus: 'code' }, {
      workspaceId: WS_ID,
      teamId: 'team-1',
      knowledgeStore: ks,
    });
    expect(res.isError).toBeFalsy();
  });
});
