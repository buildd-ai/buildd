import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, handleMemoryAction, type ApiFn, type ActionContext } from '../mcp-tools';
import { MemoryClient } from '../memory-client';
import type { KnowledgeStore, QueryResult, QueryParams } from '../knowledge-store/types';

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

// Mock store that simulates the vocabulary gap: prose query → weak code hits;
// anchor lexical query → strong code hits; spec always returns chunks with file paths + symbols.
function vocabularyGapStore(): KnowledgeStore {
  return {
    async query(namespace: string, params: QueryParams): Promise<QueryResult[]> {
      const isCode = namespace.endsWith(':code');
      const base = { namespace, corpus: (isCode ? 'code' : 'spec') as any, sourceUrl: null, metadata: {} };

      if (!isCode) {
        // Spec always returns content with implementation anchors
        return [{
          ...base, id: 's1', sourceType: 'spec',
          sourcePath: 'docs/design/merge-policy.md',
          content: [
            'BT-5: createReviewerTask + tryAutoMergeWorkerPr in',
            'apps/web/src/lib/reviewer.ts and apps/web/src/app/api/github/webhook/route.ts.',
            'resolvePolicy reads mission.mergePolicy → workspace.gitConfig.mergePolicy → legacy fields.',
            'Types: MergePolicy, MergePolicyTier in packages/shared/src/types.ts',
          ].join(' '),
          score: 0.78,
        }];
      }

      if (params.mode === 'lexical') {
        // Anchor-based lexical query: strong results (identifiers are exact matches)
        return [
          { ...base, id: 'c1', sourceType: 'code', sourcePath: 'apps/web/src/lib/reviewer.ts',
            content: 'export async function createReviewerTask(workspaceId, taskId, prNumber) { ... }', score: 0.789 },
          { ...base, id: 'c2', sourceType: 'code', sourcePath: 'apps/web/src/app/api/github/webhook/route.ts',
            content: 'async function tryAutoMergeWorkerPr(pr, workspace, policy) { ... }', score: 0.656 },
        ];
      }

      // Direct hybrid/vector code query: prose vocabulary fails to match code embeddings
      return [{ ...base, id: 'c0', sourceType: 'code', sourcePath: 'apps/web/src/lib/other.ts',
        content: '...', score: 0.013 }];
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
  // spec_compare moved from adminActions to workerActions: it is read-only
  // retrieval over {ws}:spec and {ws}:code, both of which a worker already reaches
  // via query_knowledge/recall, so admin-gating granted no protection and left the
  // spec-validator role unable to run the workflow default-roles.ts tells it to run.
  it('allows worker tokens (read-only retrieval, no new data access)', async () => {
    const result = await handleBuilddAction(noopApi, 'spec_compare', { feature: 'objectives' }, {
      workspaceId: WS_ID,
      getWorkspaceId: async () => WS_ID,
      getLevel: async () => 'worker',
      knowledgeStore: mockStore(),
    } as unknown as ActionContext);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('spec_compare');
  });

  it('still rejects trigger tokens', async () => {
    const result = await handleBuilddAction(noopApi, 'spec_compare', { feature: 'objectives' }, {
      workspaceId: WS_ID,
      getWorkspaceId: async () => WS_ID,
      getLevel: async () => 'trigger',
      knowledgeStore: mockStore(),
    } as unknown as ActionContext);
    expect(result.isError).toBe(true);
    // Trigger-level rejection is plain text, not the JSON forbidden envelope.
    expect(result.content[0].text).toMatch(/worker|forbidden|level/i);
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
        return mockStore().query(namespace, { text: 'objectives', mode: 'hybrid' });
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

describe('spec_compare — two-hop vocabulary bridge', () => {
  it('issues a second lexical :code query when spec returns implementation anchors', async () => {
    const queries: Array<{ namespace: string; text: string; mode?: string }> = [];
    const bridgeStore: KnowledgeStore = {
      async query(ns: string, params: QueryParams): Promise<QueryResult[]> {
        queries.push({ namespace: ns, text: params.text, mode: params.mode });
        return vocabularyGapStore().query(ns, params);
      },
      async upsert() {}, async delete() {}, async deleteBySource() {},
      async listNamespaces() { return []; },
    } as unknown as KnowledgeStore;

    await handleBuilddAction(noopApi, 'spec_compare',
      { feature: 'auto-merge on green CI requiresReview approval gate' },
      adminCtx({ knowledgeStore: bridgeStore }),
    );

    const codeQueries = queries.filter(q => q.namespace.endsWith(':code'));
    // Must query :code at least twice: once direct hybrid, once anchor-based lexical
    expect(codeQueries.length).toBeGreaterThanOrEqual(2);
    // Anchor query must use lexical mode
    expect(codeQueries.some(q => q.mode === 'lexical')).toBe(true);
  });

  it('prose phrasing produces strong code evidence via anchor bridge (regression)', async () => {
    const res = await handleBuilddAction(noopApi, 'spec_compare',
      { feature: 'auto-merge on green CI requiresReview approval gate' },
      adminCtx({ knowledgeStore: vocabularyGapStore() }),
    );
    const out = res.content[0].text;
    // The anchor bridge must surface the high-scoring code hits
    expect(out).toContain('reviewer.ts');
    expect(out).toContain('0.789');
    // Must not be a false DOCUMENTED-NOT-BUILT (weak hits filtered out by fusion)
    expect(out).not.toMatch(/retrieval inconclusive/i);
  });

  it('identifier phrasing also produces strong code evidence', async () => {
    const res = await handleBuilddAction(noopApi, 'spec_compare',
      { feature: 'createReviewerTask maybeDispatchReviewer tryAutoMergeWorkerPr' },
      adminCtx({ knowledgeStore: vocabularyGapStore() }),
    );
    const out = res.content[0].text;
    expect(out).toContain('reviewer.ts');
    expect(out).toContain('0.789');
  });

  it('outputs the Spec→Code bridge section listing extracted anchors', async () => {
    const res = await handleBuilddAction(noopApi, 'spec_compare',
      { feature: 'auto-merge on green CI requiresReview approval gate' },
      adminCtx({ knowledgeStore: vocabularyGapStore() }),
    );
    const out = res.content[0].text;
    // Anchor section must be present
    expect(out).toMatch(/Spec.*Code.*bridge|anchor/i);
    // Must list extracted anchors (spec content contains createReviewerTask, reviewer.ts, etc.)
    expect(out).toContain('createReviewerTask');
    expect(out).toContain('reviewer.ts');
  });

  it('fuses direct + anchor code results and deduplicates by id', async () => {
    // Store where both queries return the same chunk id — fusion must not duplicate
    const dedupeStore: KnowledgeStore = {
      async query(ns: string, params: QueryParams): Promise<QueryResult[]> {
        const isCode = ns.endsWith(':code');
        const base = { namespace: ns, corpus: (isCode ? 'code' : 'spec') as any, sourceUrl: null, metadata: {} };
        if (!isCode) {
          // Spec with an anchor
          return [{ ...base, id: 's1', sourceType: 'spec', sourcePath: 'docs/design/foo.md',
            content: 'See createReviewerTask in apps/web/src/lib/reviewer.ts', score: 0.8 }];
        }
        // Both direct and anchor queries return the same chunk id
        return [{ ...base, id: 'c1', sourceType: 'code', sourcePath: 'apps/web/src/lib/reviewer.ts',
          content: 'export function createReviewerTask() {}', score: params.mode === 'lexical' ? 0.9 : 0.3 }];
      },
      async upsert() {}, async delete() {}, async deleteBySource() {},
      async listNamespaces() { return []; },
    } as unknown as KnowledgeStore;

    const res = await handleBuilddAction(noopApi, 'spec_compare',
      { feature: 'reviewer task creation' },
      adminCtx({ knowledgeStore: dedupeStore }),
    );
    const out = res.content[0].text;
    // Must appear only once in CODE evidence (deduped)
    const codeSection = out.split('## CODE evidence')[1].split('## SPEC evidence')[0];
    const occurrences = (codeSection.match(/reviewer\.ts/g) ?? []).length;
    expect(occurrences).toBe(1);
    // Should use the higher score from lexical (0.9, not 0.3)
    expect(out).toContain('0.900');
  });

  it('reports retrieval as inconclusive when spec returns no anchors', async () => {
    const noAnchorStore: KnowledgeStore = {
      async query(ns: string): Promise<QueryResult[]> {
        const isCode = ns.endsWith(':code');
        if (isCode) return [];
        // Spec returns content with NO file paths, symbols, or identifiers
        return [{
          namespace: ns, corpus: 'spec' as any, id: 's1', sourceType: 'spec',
          sourcePath: 'docs/design/foo.md', sourceUrl: null, metadata: {},
          content: 'This feature allows users to configure settings via the user interface.',
          score: 0.72,
        }];
      },
      async upsert() {}, async delete() {}, async deleteBySource() {},
      async listNamespaces() { return []; },
    } as unknown as KnowledgeStore;

    const res = await handleBuilddAction(noopApi, 'spec_compare',
      { feature: 'user settings configuration' },
      adminCtx({ knowledgeStore: noAnchorStore }),
    );
    const out = res.content[0].text;
    // Must signal inconclusive, NOT just "(no matches)" — absence may be retrieval failure
    expect(out).toMatch(/inconclusive|no.*anchor|semantic.*only/i);
  });

  it('does not issue anchor code query when spec returns no hits', async () => {
    const queries: Array<{ namespace: string; mode?: string }> = [];
    const emptySpecStore: KnowledgeStore = {
      async query(ns: string, params: QueryParams): Promise<QueryResult[]> {
        queries.push({ namespace: ns, mode: params.mode });
        return [];
      },
      async upsert() {}, async delete() {}, async deleteBySource() {},
      async listNamespaces() { return []; },
    } as unknown as KnowledgeStore;

    await handleBuilddAction(noopApi, 'spec_compare',
      { feature: 'nonexistent feature xyz' },
      adminCtx({ knowledgeStore: emptySpecStore }),
    );

    // Only the two initial parallel queries; no extra lexical query since no anchors
    const lexicalCodeQueries = queries.filter(q => q.namespace.endsWith(':code') && q.mode === 'lexical');
    expect(lexicalCodeQueries.length).toBe(0);
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

  // Regression for the anchor bottleneck. Anchors were returned in Set insertion
  // order, i.e. pass order: every file path, then every /api/ route, then
  // camelCase, then PascalCase — truncated at 20. On anchor-dense specs the paths
  // and route strings consumed the whole budget and symbol names were dropped
  // before the lexical hop ever saw them, even though identifiers are the
  // high-signal terms for that query.
  it('ranks symbols ahead of paths and routes, and does not truncate at 20', async () => {
    let lexicalText = '';
    // 12 routes + 12 paths would have filled the old 20-slot budget outright.
    const routes = Array.from({ length: 12 }, (_, i) => `/api/things/route${i}`).join(' ');
    const paths = Array.from({ length: 12 }, (_, i) => `apps/web/src/lib/mod${i}.ts`).join(' ');
    const symbols = 'resolveMergePolicy tryAutoMergeWorkerPr createReviewerTask MergePolicyTier';

    const store = {
      async query(namespace: string, params: QueryParams): Promise<QueryResult[]> {
        const isCode = namespace.endsWith(':code');
        const base = { namespace, corpus: (isCode ? 'code' : 'spec') as any, sourceUrl: null, metadata: {} };
        if (!isCode) {
          return [{
            ...base, id: 's1', sourceType: 'spec', sourcePath: 'docs/design/x.md',
            content: `${routes} ${paths} ${symbols}`, score: 0.8,
          }];
        }
        if (params.mode === 'lexical') lexicalText = params.text ?? '';
        return [{ ...base, id: 'c1', sourceType: 'code', sourcePath: 'apps/web/src/lib/mod0.ts', content: '...', score: 0.5 }];
      },
      async upsert() {}, async delete() {}, async deleteBySource() {}, async listNamespaces() { return []; },
    } as unknown as KnowledgeStore;

    await handleBuilddAction(noopApi, 'spec_compare', { feature: 'merge policy' }, adminCtx({ knowledgeStore: store }));

    const terms = lexicalText.split(/\s+/).filter(Boolean);
    expect(terms.length).toBeGreaterThan(20); // old cap no longer binding

    // Every symbol survives, and all of them precede the first bare route string.
    const firstRouteIdx = terms.findIndex(t => t.startsWith('/api/'));
    for (const sym of symbols.split(' ')) {
      const idx = terms.indexOf(sym);
      expect(idx).toBeGreaterThanOrEqual(0);
      if (firstRouteIdx >= 0) expect(idx).toBeLessThan(firstRouteIdx);
    }
  });
});
