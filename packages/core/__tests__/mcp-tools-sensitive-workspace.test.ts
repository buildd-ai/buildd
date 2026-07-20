/**
 * Tests for sensitive-workspace memory isolation.
 *
 * Layer 2 (server-side gate): handleLearnAction, handleRecallAction, and
 * handleMemoryAction must reject writes and return empty reads when the
 * MemoryActionCtx carries isSensitive=true.
 *
 * Layer 1 (tool unmount) lives in the HTTP route and is not tested here.
 */
import { describe, it, expect, mock } from 'bun:test';

// Mock DB modules that mcp-tools imports transitively.
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));
mock.module('../db/index', () => ({
  db: { execute: () => Promise.resolve({ rows: [] }) },
}));

const { handleLearnAction, handleRecallAction, handleMemoryAction } = await import('../mcp-tools');

// ── Shared helpers ─────────────────────────────────────────────────────────────

const TEAM_ID = '00000000-0000-0000-0000-000000000011';
const WS_ID   = '00000000-0000-0000-0000-000000000022';

function makeMemoryClient(overrides: Record<string, any> = {}) {
  const saved: any[] = [];
  return {
    saved,
    async save(input: any) {
      saved.push(input);
      return { memory: { id: 'mem-1', title: input.title, content: input.content, type: input.type, tags: [], files: [] } };
    },
    async update(_id: string, fields: any) {
      return { memory: { id: _id, ...fields, tags: [], files: [] } };
    },
    async get(id: string) {
      return { memory: { id, title: 'T', content: 'C', type: 'gotcha' } };
    },
    async search() {
      return { results: [{ id: 'mem-1', title: 'T', type: 'gotcha', files: [], tags: [] }], total: 1 };
    },
    async batch(ids: string[]) {
      return { memories: ids.map(id => ({ id, title: 'T', content: 'C', type: 'gotcha', files: [], tags: [] })) };
    },
    async delete(id: string) {},
    async getContext() {
      return { markdown: '## Team Memory\n- some content' };
    },
    ...overrides,
  };
}

function makeStore() {
  const queries: string[] = [];
  return {
    queries,
    async query(ns: string, params: any) {
      queries.push(ns);
      return [{ id: 'c-1', content: 'prior work', score: 0.9, sourceType: 'memory', sourceUrl: '/m/1', metadata: {}, isCurrent: true }];
    },
    async upsert() { return { superseded: 0 }; },
    async delete() {},
    async listNamespaces() { return []; },
  };
}

function sensitiveCtx(extra: Record<string, any> = {}) {
  return {
    workerId: 'w-1',
    workspaceId: WS_ID,
    teamId: TEAM_ID,
    isSensitive: true,
    knowledgeStore: makeStore() as any,
    embedder: null,
    ...extra,
  };
}

function standardCtx(extra: Record<string, any> = {}) {
  return {
    workerId: 'w-1',
    workspaceId: WS_ID,
    teamId: TEAM_ID,
    isSensitive: false,
    knowledgeStore: makeStore() as any,
    embedder: null,
    ...extra,
  };
}

// ── handleLearnAction ─────────────────────────────────────────────────────────

describe('handleLearnAction — sensitive workspace', () => {
  it('rejects learn writes when isSensitive=true', async () => {
    const mc = makeMemoryClient();
    const result = await handleLearnAction(mc as any, {
      type: 'gotcha',
      title: 'Secret finding',
      content: 'Do not leak this',
    }, sensitiveCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/sensitive/i);
    expect(result.content[0].text).toMatch(/memory writes disabled/i);
    expect(mc.saved).toHaveLength(0);
  });

  it('allows learn writes when isSensitive=false', async () => {
    const mc = makeMemoryClient();
    const result = await handleLearnAction(mc as any, {
      type: 'gotcha',
      title: 'Normal finding',
      content: 'This is fine',
    }, standardCtx());

    expect(result.isError).toBeFalsy();
    expect(mc.saved).toHaveLength(1);
  });
});

// ── handleRecallAction ────────────────────────────────────────────────────────

describe('handleRecallAction — sensitive workspace', () => {
  it('returns empty (no error) for memory scope when isSensitive=true', async () => {
    const mc = makeMemoryClient();
    const result = await handleRecallAction(mc as any, {
      query: 'prior lessons',
      // scope defaults to 'memory'
    }, sensitiveCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/sensitive/i);
    // Must NOT contain actual memory content
    expect(result.content[0].text).not.toContain('prior work');
  });

  it('returns empty for explicit scope=memory when isSensitive=true', async () => {
    const mc = makeMemoryClient();
    const result = await handleRecallAction(mc as any, {
      query: 'prior lessons',
      scope: 'memory',
    }, sensitiveCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/sensitive/i);
  });

  it('allows non-memory scopes when isSensitive=true', async () => {
    const mc = makeMemoryClient();
    const store = makeStore();
    const result = await handleRecallAction(mc as any, {
      query: 'task outcomes',
      scope: 'task',
    }, { ...sensitiveCtx(), knowledgeStore: store as any });

    // task scope is workspace-scoped and not blocked
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Found');
  });

  it('normal recall works when isSensitive=false', async () => {
    const mc = makeMemoryClient();
    const result = await handleRecallAction(mc as any, {
      query: 'prior lessons',
    }, standardCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Found');
  });
});

// ── handleMemoryAction — save ─────────────────────────────────────────────────

describe('handleMemoryAction(save) — sensitive workspace', () => {
  it('rejects save when isSensitive=true', async () => {
    const mc = makeMemoryClient();
    const result = await handleMemoryAction(mc as any, 'save', {
      type: 'gotcha',
      title: 'Secret',
      content: 'Private content',
    }, sensitiveCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/sensitive/i);
    expect(mc.saved).toHaveLength(0);
  });

  it('allows save when isSensitive=false', async () => {
    const mc = makeMemoryClient();
    const result = await handleMemoryAction(mc as any, 'save', {
      type: 'gotcha',
      title: 'Normal',
      content: 'Fine content',
    }, standardCtx());

    expect(result.isError).toBeFalsy();
    expect(mc.saved).toHaveLength(1);
  });
});

// ── handleMemoryAction — search ───────────────────────────────────────────────

describe('handleMemoryAction(search) — sensitive workspace', () => {
  it('returns empty (no error) for search when isSensitive=true', async () => {
    const mc = makeMemoryClient();
    const result = await handleMemoryAction(mc as any, 'search', {
      query: 'anything',
    }, sensitiveCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/sensitive/i);
  });

  it('allows search when isSensitive=false', async () => {
    const mc = makeMemoryClient();
    const result = await handleMemoryAction(mc as any, 'search', {
      query: 'gotcha',
    }, standardCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Found');
  });
});

// ── handleMemoryAction — context ──────────────────────────────────────────────

describe('handleMemoryAction(context) — sensitive workspace', () => {
  it('returns empty (no error) for context when isSensitive=true', async () => {
    const mc = makeMemoryClient();
    const result = await handleMemoryAction(mc as any, 'context', {}, sensitiveCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/sensitive/i);
    // Must not return actual memory content
    expect(result.content[0].text).not.toContain('some content');
  });
});

// ── handleMemoryAction — query_knowledge corpus=memory ────────────────────────

describe('handleMemoryAction(query_knowledge, corpus=memory) — sensitive workspace', () => {
  it('returns empty (no error) for query_knowledge with default corpus (memory) when isSensitive=true', async () => {
    const mc = makeMemoryClient();
    const result = await handleMemoryAction(mc as any, 'query_knowledge', {
      query: 'prior gotchas',
      // corpus defaults to 'memory'
    }, sensitiveCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/sensitive/i);
  });

  it('returns empty for explicit corpus=memory when isSensitive=true', async () => {
    const mc = makeMemoryClient();
    const result = await handleMemoryAction(mc as any, 'query_knowledge', {
      query: 'prior gotchas',
      corpus: 'memory',
    }, sensitiveCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/sensitive/i);
  });

  it('allows query_knowledge for non-memory corpus when isSensitive=true', async () => {
    const mc = makeMemoryClient();
    const store = makeStore();
    const result = await handleMemoryAction(mc as any, 'query_knowledge', {
      query: 'prior builds',
      corpus: 'task',
    }, { ...sensitiveCtx(), knowledgeStore: store as any });

    // task corpus is workspace-scoped — not blocked
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Found');
  });

  it('normal query_knowledge(memory) works when isSensitive=false', async () => {
    const mc = makeMemoryClient();
    const store = makeStore();
    const result = await handleMemoryAction(mc as any, 'query_knowledge', {
      query: 'prior gotchas',
      corpus: 'memory',
    }, { ...standardCtx(), knowledgeStore: store as any });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Found');
  });
});

// ── Fail-closed: unresolvable dataClass ──────────────────────────────────────

describe('fail-closed: undefined isSensitive treated as NOT sensitive', () => {
  // The fail-closed rule applies when dataClass is unresolvable (e.g. DB error
  // in the route). The route defaults to isSensitive=true on failure; the
  // handlers themselves don't need to know — they trust the flag.
  // This test just confirms the standard path isn't broken by absence of the flag.
  it('allows learn when isSensitive is absent (treated as false)', async () => {
    const mc = makeMemoryClient();
    const ctx: any = { workspaceId: WS_ID, teamId: TEAM_ID, knowledgeStore: makeStore() as any, embedder: null };
    const result = await handleLearnAction(mc as any, {
      type: 'gotcha', title: 'T', content: 'C',
    }, ctx);
    expect(result.isError).toBeFalsy();
  });
});
