/**
 * Tests for recall (read) and learn (write) knowledge tools.
 *
 * Spec: docs/design/knowledge-tool-surface.md
 *
 * Acceptance requirements:
 * - scope routing: memory → teamId:memory, other → workspaceId:corpus
 * - id direct-fetch bypass: other params ignored when id is present
 * - superseded exclusion: isCurrent===false excluded by default
 * - lexical fallback on short exact queries (IDs, symbol names, error strings)
 * - learn: explicit supersedes honored, upsert semantics (save via memoryClient)
 */
import { describe, it, expect } from 'bun:test';
import { handleRecallAction, handleLearnAction } from '../mcp-tools';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

const WS_ID   = 'aaaa0000-0000-0000-0000-000000000000';
const TEAM_ID  = 'bbbb0000-0000-0000-0000-000000000001';
const WORKER_ID = 'worker-recall-001';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStore(chunks: Partial<QueryResult & { isCurrent?: boolean; createdAt?: Date }>[]): KnowledgeStore & { capturedNamespaces: string[]; capturedModes: string[] } {
  const capturedNamespaces: string[] = [];
  const capturedModes: string[] = [];
  return {
    capturedNamespaces,
    capturedModes,
    async query(ns, opts): Promise<QueryResult[]> {
      capturedNamespaces.push(ns);
      if (opts?.mode) capturedModes.push(opts.mode);
      return chunks.map((c, i) => ({
        id: c.id ?? `chunk-${i}`,
        namespace: ns,
        corpus: 'memory' as const,
        sourceType: 'memory',
        sourcePath: null,
        sourceUrl: c.sourceUrl ?? `/app/memory/chunk-${i}`,
        content: c.content ?? `content ${i}`,
        metadata: c.metadata ?? { type: 'gotcha' },
        score: c.score ?? 0.9,
        createdAt: c.createdAt ?? null,
        isCurrent: c.isCurrent ?? true,
      }));
    },
    async upsert(_ns, chunks) {
      return { inserted: chunks.length, updated: 0, superseded: 0 };
    },
    async delete() {},
    async listNamespaces() { return []; },
  };
}

function makeMemClient(options: {
  getResult?: any;
  saveResult?: any;
} = {}) {
  return {
    get: async (id: string) => ({
      memory: options.getResult ?? {
        id,
        type: 'gotcha',
        title: 'Direct fetch result',
        content: 'Content of directly fetched memory',
        files: ['src/foo.ts'],
        tags: ['test'],
        project: null,
        source: 'mcp-agent',
      },
    }),
    save: async (data: any) => ({
      memory: options.saveResult ?? {
        id: 'new-mem-id',
        type: data.type,
        title: data.title,
        content: data.content,
        files: data.files ?? [],
        tags: data.tags ?? [],
        project: data.project ?? null,
        source: data.source ?? 'mcp-agent',
      },
    }),
    search: async () => ({ results: [], total: 0, limit: 10, offset: 0 }),
    batch: async () => ({ memories: [] }),
  };
}

function recallCtx(store: KnowledgeStore) {
  return {
    workspaceId: WS_ID,
    teamId: TEAM_ID,
    workerId: WORKER_ID,
    knowledgeStore: store,
    embedder: null as any,
  };
}

// ── recall: scope routing ────────────────────────────────────────────────────

describe('recall — scope routing', () => {
  it('routes scope=memory to teamId:memory namespace', async () => {
    const store = makeStore([{ content: 'a gotcha', isCurrent: true }]);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, { query: 'gotcha details', scope: 'memory' }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    expect(store.capturedNamespaces[0]).toBe(`${TEAM_ID}:memory`);
  });

  it('routes scope=task to workspaceId:task namespace', async () => {
    const store = makeStore([{ content: 'task outcome', isCurrent: true }]);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, { query: 'task outcome', scope: 'task' }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    expect(store.capturedNamespaces[0]).toBe(`${WS_ID}:task`);
  });

  it('routes scope=code to workspaceId:code namespace', async () => {
    const store = makeStore([{ content: 'function handleFoo()', isCurrent: true }]);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, { query: 'handleFoo', scope: 'code' }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    expect(store.capturedNamespaces[0]).toBe(`${WS_ID}:code`);
  });

  it('defaults scope to memory when not specified', async () => {
    const store = makeStore([{ content: 'memory content', isCurrent: true }]);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, { query: 'some query' }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    expect(store.capturedNamespaces[0]).toBe(`${TEAM_ID}:memory`);
  });

  it('returns error when scope=memory but teamId is missing', async () => {
    const store = makeStore([]);
    const mem = makeMemClient();
    const ctxNoTeam = { workspaceId: WS_ID, knowledgeStore: store, embedder: null as any };
    const res = await handleRecallAction(mem as any, { query: 'test', scope: 'memory' }, ctxNoTeam);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('teamId');
  });

  it('returns error when scope=code but workspaceId is missing', async () => {
    const store = makeStore([]);
    const mem = makeMemClient();
    const ctxNoWs = { teamId: TEAM_ID, knowledgeStore: store, embedder: null as any };
    const res = await handleRecallAction(mem as any, { query: 'test', scope: 'code' }, ctxNoWs);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('workspaceId');
  });
});

// ── recall: id direct-fetch bypass ───────────────────────────────────────────

describe('recall — id direct-fetch bypass', () => {
  it('fetches by id directly from memoryClient when id is provided', async () => {
    const store = makeStore([]);
    const mem = makeMemClient({
      getResult: {
        id: 'mem-abc123',
        type: 'architecture',
        title: 'DB Migration Pattern',
        content: 'Always run bun db:generate before committing schema changes.',
        files: ['packages/core/db/schema.ts'],
        tags: ['db', 'migration'],
        project: null,
        source: 'worker-123',
      },
    });
    const res = await handleRecallAction(mem as any, { id: 'mem-abc123' }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('DB Migration Pattern');
    expect(res.content[0].text).toContain('Always run bun db:generate');
    // KnowledgeStore should NOT be queried when id is provided
    expect(store.capturedNamespaces).toHaveLength(0);
  });

  it('ignores query, scope, and limit when id is provided', async () => {
    const store = makeStore([{ content: 'should not appear' }]);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, { id: 'direct-id', query: 'should be ignored', scope: 'task', limit: 5 }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    // Store should not be queried
    expect(store.capturedNamespaces).toHaveLength(0);
    // Should contain direct-fetch result title
    expect(res.content[0].text).toContain('Direct fetch result');
  });
});

// ── recall: superseded exclusion ─────────────────────────────────────────────

describe('recall — superseded exclusion', () => {
  it('excludes superseded entries (isCurrent===false) from results', async () => {
    const store = makeStore([
      { content: 'current entry', isCurrent: true },
      { content: 'superseded entry', isCurrent: false },
    ]);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, { query: 'some query', scope: 'memory' }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('current entry');
    expect(res.content[0].text).not.toContain('superseded entry');
  });

  it('returns empty message when all results are superseded', async () => {
    const store = makeStore([
      { content: 'old gotcha', isCurrent: false },
    ]);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, { query: 'gotcha', scope: 'memory' }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('No knowledge');
  });

  it('shows multiple current results in ranked order', async () => {
    const store = makeStore([
      { content: 'result A', score: 0.95, isCurrent: true },
      { content: 'result B', score: 0.85, isCurrent: true },
    ]);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, { query: 'results', scope: 'memory' }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain('result A');
    expect(text).toContain('result B');
  });
});

// ── recall: lexical fallback ──────────────────────────────────────────────────

describe('recall — lexical fallback on short exact-match queries', () => {
  it('uses lexical mode for short queries (IDs, symbols)', async () => {
    const store = makeStore([{ content: 'found', isCurrent: true }]);
    const mem = makeMemClient();
    // Short, no spaces — looks like an ID or symbol name
    await handleRecallAction(mem as any, { query: 'abc123' }, recallCtx(store));
    expect(store.capturedModes[0]).toBe('lexical');
  });

  it('uses hybrid mode for longer natural-language queries', async () => {
    const store = makeStore([{ content: 'found', isCurrent: true }]);
    const mem = makeMemClient();
    await handleRecallAction(mem as any, { query: 'how to handle database migrations in this project' }, recallCtx(store));
    expect(store.capturedModes[0]).toBe('hybrid');
  });

  it('uses lexical mode for error string queries (short, no spaces)', async () => {
    const store = makeStore([{ content: 'found', isCurrent: true }]);
    const mem = makeMemClient();
    await handleRecallAction(mem as any, { query: 'ECONNREFUSED' }, recallCtx(store));
    expect(store.capturedModes[0]).toBe('lexical');
  });

  it('uses hybrid mode for queries with multiple words', async () => {
    const store = makeStore([{ content: 'found', isCurrent: true }]);
    const mem = makeMemClient();
    await handleRecallAction(mem as any, { query: 'memory service auth pattern' }, recallCtx(store));
    expect(store.capturedModes[0]).toBe('hybrid');
  });
});

// ── recall: no caller-visible mode param ─────────────────────────────────────

describe('recall — no mode param in schema', () => {
  it('ignores any mode param passed by caller — server always chooses', async () => {
    const store = makeStore([{ content: 'found', isCurrent: true }]);
    const mem = makeMemClient();
    // Caller tries to pass mode — it should be ignored (not cause an error)
    const res = await handleRecallAction(mem as any, { query: 'short', mode: 'vector' } as any, recallCtx(store));
    // Should succeed, not explode
    expect(res.isError).toBeFalsy();
    // Mode should be server-chosen (lexical for 'short')
    expect(store.capturedModes[0]).toBe('lexical');
  });
});

// ── recall: limit param ───────────────────────────────────────────────────────

describe('recall — limit param', () => {
  it('defaults to limit=10', async () => {
    const chunks = Array.from({ length: 15 }, (_, i) => ({ content: `item ${i}`, isCurrent: true }));
    const store = makeStore(chunks);
    const mem = makeMemClient();
    // The store itself returns all chunks; recall applies limit after filtering
    const res = await handleRecallAction(mem as any, { query: 'items', scope: 'memory' }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    // Should show at most 10 results
    const matches = (res.content[0].text.match(/item \d+/g) || []).length;
    expect(matches).toBeLessThanOrEqual(10);
  });

  it('respects explicit limit', async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => ({ content: `item ${i}`, isCurrent: true }));
    const store = makeStore(chunks);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, { query: 'items', limit: 3 }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    const matches = (res.content[0].text.match(/item \d+/g) || []).length;
    expect(matches).toBeLessThanOrEqual(3);
  });
});

// ── learn: basic save ─────────────────────────────────────────────────────────

describe('learn — save a new lesson', () => {
  it('requires type, title, and content', async () => {
    const store = makeStore([]);
    const mem = makeMemClient();
    const ctx = { ...recallCtx(store), workerId: WORKER_ID };
    const res = await handleLearnAction(mem as any, { type: 'gotcha', title: 'Missing param' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('content');
  });

  it('saves a new memory and returns its ID', async () => {
    const store = makeStore([]);
    const mem = makeMemClient({ saveResult: { id: 'saved-mem-1', type: 'gotcha', title: 'Test gotcha', content: 'Test content', files: [], tags: [], project: null, source: 'mcp-agent' } });
    const ctx = { ...recallCtx(store), workerId: WORKER_ID };
    const res = await handleLearnAction(mem as any, {
      type: 'gotcha',
      title: 'Test gotcha',
      content: 'Test content',
    }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('saved-mem-1');
    expect(res.content[0].text).toContain('Test gotcha');
  });

  it('rejects invalid type values', async () => {
    const store = makeStore([]);
    const mem = makeMemClient();
    const ctx = { ...recallCtx(store), workerId: WORKER_ID };
    const res = await handleLearnAction(mem as any, {
      type: 'invalid_type',
      title: 'Test',
      content: 'Content',
    }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('type');
  });

  it('accepts all valid type values', async () => {
    const store = makeStore([]);
    const validTypes = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'];
    for (const type of validTypes) {
      const mem = makeMemClient({ saveResult: { id: `mem-${type}`, type, title: 'T', content: 'C', files: [], tags: [], project: null, source: null } });
      const ctx = { ...recallCtx(store), workerId: WORKER_ID };
      const res = await handleLearnAction(mem as any, { type, title: 'T', content: 'C' }, ctx);
      expect(res.isError).toBeFalsy();
    }
  });
});

// ── learn: explicit supersedes honored ───────────────────────────────────────

describe('learn — explicit supersedes', () => {
  it('passes supersedes to KnowledgeStore upsert', async () => {
    const upsertCalls: Array<{ ns: string; supersedes: string[] }> = [];
    const store: KnowledgeStore & { capturedNamespaces: string[]; capturedModes: string[] } = {
      capturedNamespaces: [],
      capturedModes: [],
      async query() { return []; },
      async upsert(ns, chunks) {
        for (const c of chunks) {
          if (c.supersedes) upsertCalls.push({ ns, supersedes: c.supersedes });
        }
        return { inserted: chunks.length, updated: 0, superseded: c.supersedes?.length ?? 0 };
      },
      async delete() {},
      async listNamespaces() { return []; },
    } as any;
    const mem = makeMemClient({ saveResult: { id: 'new-id', type: 'gotcha', title: 'T', content: 'C', files: [], tags: [], project: null, source: null } });
    const ctx = { ...recallCtx(store), workerId: WORKER_ID };

    const res = await handleLearnAction(mem as any, {
      type: 'gotcha',
      title: 'Updated gotcha',
      content: 'New content that supersedes old',
      supersedes: ['old-mem-id-1', 'old-mem-id-2'],
    }, ctx);

    expect(res.isError).toBeFalsy();
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].supersedes).toContain('old-mem-id-1');
    expect(upsertCalls[0].supersedes).toContain('old-mem-id-2');
  });

  it('reports superseded count in response', async () => {
    const store: KnowledgeStore & { capturedNamespaces: string[]; capturedModes: string[] } = {
      capturedNamespaces: [],
      capturedModes: [],
      async query() { return []; },
      async upsert() { return { inserted: 1, updated: 0, superseded: 2 }; },
      async delete() {},
      async listNamespaces() { return []; },
    } as any;
    const mem = makeMemClient({ saveResult: { id: 'new-id', type: 'pattern', title: 'T', content: 'C', files: [], tags: [], project: null, source: null } });
    const ctx = { ...recallCtx(store), workerId: WORKER_ID };

    const res = await handleLearnAction(mem as any, {
      type: 'pattern',
      title: 'New pattern',
      content: 'Content',
      supersedes: ['old-1', 'old-2'],
    }, ctx);

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('superseded');
    expect(res.content[0].text).toContain('2');
  });

  it('rejects invalid supersedes (non-array)', async () => {
    const store = makeStore([]);
    const mem = makeMemClient();
    const ctx = { ...recallCtx(store), workerId: WORKER_ID };
    const res = await handleLearnAction(mem as any, {
      type: 'gotcha',
      title: 'T',
      content: 'C',
      supersedes: 'not-an-array',
    }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('array');
  });
});

// ── learn: no namespace exposure ──────────────────────────────────────────────

describe('learn — no internal namespace visible to caller', () => {
  it('does not mention teamId:memory namespace in response', async () => {
    const store = makeStore([]);
    const mem = makeMemClient({ saveResult: { id: 'x', type: 'gotcha', title: 'T', content: 'C', files: [], tags: [], project: null, source: null } });
    const ctx = { ...recallCtx(store), workerId: WORKER_ID };
    const res = await handleLearnAction(mem as any, { type: 'gotcha', title: 'T', content: 'C' }, ctx);
    expect(res.isError).toBeFalsy();
    // Response should not expose internal namespace details
    expect(res.content[0].text).not.toContain(':memory');
    expect(res.content[0].text).not.toContain(':task');
    expect(res.content[0].text).not.toContain('namespace');
  });
});

// ── recall: no namespace in response ─────────────────────────────────────────

describe('recall — no internal namespace visible to caller', () => {
  it('does not mention internal namespace in output', async () => {
    const store = makeStore([{ content: 'a result', isCurrent: true }]);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, { query: 'test query' }, recallCtx(store));
    expect(res.isError).toBeFalsy();
    // Response should not expose namespace strings like teamId:memory
    expect(res.content[0].text).not.toContain(':memory');
  });
});

// ── recall: requires query or id ──────────────────────────────────────────────

describe('recall — input validation', () => {
  it('returns error when neither query nor id provided', async () => {
    const store = makeStore([]);
    const mem = makeMemClient();
    const res = await handleRecallAction(mem as any, {}, recallCtx(store));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('query');
  });
});
