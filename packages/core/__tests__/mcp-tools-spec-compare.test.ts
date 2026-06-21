import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

const NS = '471effe1-0000-0000-0000-000000000000';
const noopApi = (async () => ({})) as unknown as ApiFn;

// Mock store: code side returns the *missions* table (a semantic neighbour of
// "objectives"), docs side returns a full objectives page — the exact shape that
// fools a score gate but that a judge resolves from the snippets.
function mockStore(): KnowledgeStore {
  return {
    async query(namespace: string): Promise<QueryResult[]> {
      const isCode = namespace.endsWith(':code');
      const base = { namespace, corpus: (isCode ? 'code' : 'docs') as any, sourceUrl: null, metadata: {} };
      return isCode
        ? [{ ...base, id: 'c1', sourceType: 'code', sourcePath: 'core/db/schema.ts', content: "export const missions = pgTable('missions', { ... })", score: 0.445 }]
        : [{ ...base, id: 'd1', sourceType: 'docs', sourcePath: 'content/docs/features/objectives.mdx', content: 'Objectives track goals and link tasks...', score: 0.75 }];
    },
    async upsert() {}, async delete() {}, async deleteBySource() {}, async listNamespaces() { return []; },
  } as unknown as KnowledgeStore;
}

function adminCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: 'ws-1',
    getWorkspaceId: async () => 'ws-1',
    getLevel: async () => 'admin',
    knowledgeStore: mockStore(),
    ...overrides,
  };
}

describe('spec_compare', () => {
  it('rejects non-admin tokens', async () => {
    const err = await handleBuilddAction(noopApi, 'spec_compare', { feature: 'objectives', namespace: NS }, {
      workspaceId: 'ws-1', getWorkspaceId: async () => 'ws-1', getLevel: async () => 'worker',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('admin');
  });

  it('requires a feature/query', async () => {
    const err = await handleBuilddAction(noopApi, 'spec_compare', { namespace: NS }, adminCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/feature|query/i);
  });

  it('falls back to the default namespace when none is configured', async () => {
    const prev = process.env.SPEC_SYNC_NAMESPACE;
    delete process.env.SPEC_SYNC_NAMESPACE;
    const res = await handleBuilddAction(noopApi, 'spec_compare', { feature: 'objectives' }, adminCtx());
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('schema.ts'); // queried code side via default ns
    if (prev) process.env.SPEC_SYNC_NAMESPACE = prev;
  });

  it('returns both code and docs evidence with judge framing (scores surface, judge decides)', async () => {
    const res = await handleBuilddAction(noopApi, 'spec_compare', { feature: 'objectives', namespace: NS }, adminCtx());
    const out = res.content[0].text;
    // both sides present
    expect(out).toContain('schema.ts');
    expect(out).toContain('objectives.mdx');
    expect(out).toContain('0.445');
    expect(out).toContain('0.75');
    // explicitly frames the judge step and warns scores are not a verdict
    expect(out).toMatch(/judge|verdict|implement/i);
    expect(res.isError).toBeFalsy();
  });
});
