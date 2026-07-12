import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock drizzle-orm + db BEFORE mcp-tools' dynamic imports run, so
// resolveAndPersistEntities (used by processEntityRefs) can bind agent refs
// without a real database. Shapes are identical to the mocks in
// knowledge-entity-resolver.test.ts (mock.module is process-global).
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));

function sqlText(q: any): string {
  if (!q || typeof q !== 'object') return '';
  if (Array.isArray(q.parts)) return q.parts.map(sqlText).join(', ');
  if (q.strings) {
    let out = '';
    const values: any[] = q.values ?? [];
    Array.from(q.strings as string[]).forEach((s, i) => {
      out += s;
      if (i < values.length) {
        const v = values[i];
        out += v && typeof v === 'object' && (v.strings || v.parts) ? sqlText(v) : JSON.stringify(v);
      }
    });
    return out;
  }
  return '';
}

// Entity-resolver driver: exact-match SELECTs resolve to a fixed entity id,
// entity INSERT..RETURNING yields ids, everything else returns no rows.
mock.module('../db/index', () => ({
  db: {
    execute: (q: unknown) => {
      const text = sqlText(q);
      if (text.includes('SELECT id FROM knowledge_entities')) {
        return Promise.resolve({ rows: [{ id: 'ent-defines-1' }] });
      }
      if (text.includes('INSERT INTO knowledge_entities')) {
        return Promise.resolve({ rows: [{ id: 'ent-extracted' }] });
      }
      return Promise.resolve({ rows: [] });
    },
  },
}));

const { handleBuilddAction, handleMemoryAction } = await import('../mcp-tools');
type ApiFn = import('../mcp-tools').ApiFn;
type ActionContext = import('../mcp-tools').ActionContext;
import type { KnowledgeStore, UpsertChunk, UpsertResult } from '../knowledge-store/types';

const WS = '00000000-0000-0000-0000-000000000001';
const TEAM = '00000000-0000-0000-0000-0000000000aa';

// ── Recording store with supersession support ────────────────────────────────

interface SupersessionCall {
  namespace: string;
  newSourceId: string;
  entityIds: string[];
  opts?: { corpus?: string; sourceTs?: Date | null };
}

function makeStore(upsertResult?: UpsertResult) {
  const upserts: Array<{ namespace: string; chunks: UpsertChunk[] }> = [];
  const supersessionCalls: SupersessionCall[] = [];
  const store: KnowledgeStore & {
    upserts: typeof upserts;
    supersessionCalls: typeof supersessionCalls;
  } = {
    upserts,
    supersessionCalls,
    async upsert(namespace, chunks) {
      upserts.push({ namespace, chunks });
      return upsertResult;
    },
    async query() {
      return [];
    },
    async delete() {},
    async listNamespaces() {
      return [];
    },
    async markSupersededByEntities(namespace, newSourceId, entityIds, opts) {
      supersessionCalls.push({ namespace, newSourceId, entityIds, opts });
      return 0;
    },
  };
  return store;
}

function ctxWith(store: KnowledgeStore, teamId?: string): ActionContext {
  return {
    workerId: 'w-1',
    workspaceId: WS,
    teamId,
    getWorkspaceId: async () => WS,
    getLevel: async () => 'worker',
    knowledgeStore: store,
    embedder: null,
  };
}

function routedApi(routes: Record<string, any>, calls?: string[]): ApiFn {
  return (async (endpoint: string, opts?: any) => {
    const method = opts?.method ?? 'GET';
    const key = `${method} ${endpoint}`;
    calls?.push(key);
    if (key in routes) return routes[key];
    for (const [k, v] of Object.entries(routes)) {
      if (key.startsWith(k)) return v;
    }
    return {};
  }) as ApiFn;
}

const completeTaskRoutes = {
  'PATCH /api/workers/w-1': { turns: 2 },
  'GET /api/workers/w-1': { taskId: 't-1', completedAt: '2026-07-10T00:00:00.000Z' },
  'GET /api/tasks/t-1': { title: 'Fix auth', description: 'd', result: { summary: 'done' } },
};

function mockMemoryClient(): any {
  const mem = (over: any = {}) => ({
    id: 'mem-1', title: 'T', content: 'C', type: 'gotcha', tags: [], files: [], project: null, ...over,
  });
  return {
    async save(input: any) { return { memory: mem(input) }; },
    async update(_id: string, fields: any) { return { memory: mem(fields) }; },
    async delete() {},
  };
}

// ── complete_task supersedes param ────────────────────────────────────────────

describe('complete_task — supersedes param', () => {
  it('plumbs supersedes into the mirrored task chunk and reports the count', async () => {
    const store = makeStore({ superseded: 2 });
    const res = await handleBuilddAction(
      routedApi(completeTaskRoutes),
      'complete_task',
      { summary: 'done', supersedes: ['task:t-old', 'task:t-older'] },
      ctxWith(store),
    );

    expect(res.isError).toBeFalsy();
    // Two mirrors now: the task card (carries supersedes) + the session card.
    expect(store.upserts).toHaveLength(2);
    const taskUpsert = store.upserts.find(u => u.chunks[0]?.id?.startsWith('task:'));
    expect(taskUpsert?.chunks[0].supersedes).toEqual(['task:t-old', 'task:t-older']);
    expect(res.content[0].text).toContain('Superseded: 2');
  });

  it('rejects malformed supersedes without completing the task', async () => {
    const calls: string[] = [];
    const store = makeStore();
    const res = await handleBuilddAction(
      routedApi(completeTaskRoutes, calls),
      'complete_task',
      { summary: 'done', supersedes: 'task:t-old' },
      ctxWith(store),
    );

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('supersedes');
    expect(calls.filter(c => c.startsWith('PATCH'))).toHaveLength(0);
    expect(store.upserts).toHaveLength(0);
  });

  it('rejects non-string entries in supersedes', async () => {
    const res = await handleBuilddAction(
      routedApi(completeTaskRoutes),
      'complete_task',
      { summary: 'done', supersedes: [42] },
      ctxWith(makeStore()),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('supersedes');
  });

  it('does not emit a superseded acknowledgment when the param is absent', async () => {
    const res = await handleBuilddAction(
      routedApi(completeTaskRoutes),
      'complete_task',
      { summary: 'done' },
      ctxWith(makeStore()),
    );
    expect(res.content[0].text).not.toContain('Superseded:');
  });
});

// ── entity-keyed supersession wiring ─────────────────────────────────────────

describe('entity-keyed supersession wiring', () => {
  it('complete_task calls markSupersededByEntities with bound defines entity ids', async () => {
    const store = makeStore();
    await handleBuilddAction(
      routedApi(completeTaskRoutes),
      'complete_task',
      {
        summary: 'done',
        entities: [{ kind: 'concept', ref: 'auth flow', role: 'defines' }],
      },
      ctxWith(store),
    );

    expect(store.supersessionCalls).toHaveLength(1);
    const call = store.supersessionCalls[0];
    expect(call.namespace).toBe(`${WS}:task`);
    expect(call.newSourceId).toBe('task:t-1');
    expect(call.entityIds).toEqual(['ent-defines-1']);
  });

  it('does not fire entity-keyed supersession without defines-role refs', async () => {
    const store = makeStore();
    await handleBuilddAction(
      routedApi(completeTaskRoutes),
      'complete_task',
      {
        summary: 'done',
        entities: [{ kind: 'concept', ref: 'auth flow', role: 'mentions' }],
      },
      ctxWith(store),
    );

    expect(store.supersessionCalls).toHaveLength(0);
  });

  it('memory save calls markSupersededByEntities in the team memory namespace', async () => {
    const store = makeStore();
    await handleMemoryAction(
      mockMemoryClient(),
      'save',
      {
        type: 'gotcha',
        title: 'X',
        content: 'Y',
        entities: [{ kind: 'concept', ref: 'budget reset', role: 'defines' }],
      },
      ctxWith(store, TEAM),
    );

    expect(store.supersessionCalls).toHaveLength(1);
    expect(store.supersessionCalls[0].namespace).toBe(`${TEAM}:memory`);
    expect(store.supersessionCalls[0].newSourceId).toBe('mem-1');
  });
});

// ── buildd_memory save/update supersedes param ────────────────────────────────

describe('buildd_memory — supersedes param', () => {
  it('save plumbs supersedes into the mirrored chunk and reports the count', async () => {
    const store = makeStore({ superseded: 1 });
    const res = await handleMemoryAction(
      mockMemoryClient(),
      'save',
      { type: 'gotcha', title: 'X', content: 'Y', supersedes: ['mem-old'] },
      ctxWith(store, TEAM),
    );

    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0].chunks[0].supersedes).toEqual(['mem-old']);
    expect(res.content[0].text.toLowerCase()).toContain('superseded: 1');
  });

  it('update plumbs supersedes into the mirrored chunk and reports the count', async () => {
    const store = makeStore({ superseded: 1 });
    const res = await handleMemoryAction(
      mockMemoryClient(),
      'update',
      { id: 'mem-1', content: 'Z', supersedes: ['mem-old'] },
      ctxWith(store, TEAM),
    );

    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0].chunks[0].supersedes).toEqual(['mem-old']);
    expect(res.content[0].text.toLowerCase()).toContain('superseded: 1');
  });

  it('save rejects malformed supersedes cleanly', async () => {
    const store = makeStore();
    await expect(
      handleMemoryAction(
        mockMemoryClient(),
        'save',
        { type: 'gotcha', title: 'X', content: 'Y', supersedes: 'mem-old' },
        ctxWith(store, TEAM),
      ),
    ).rejects.toThrow(/supersedes/);
    expect(store.upserts).toHaveLength(0);
  });

  it('update rejects malformed supersedes cleanly', async () => {
    await expect(
      handleMemoryAction(
        mockMemoryClient(),
        'update',
        { id: 'mem-1', content: 'Z', supersedes: [null] },
        ctxWith(makeStore(), TEAM),
      ),
    ).rejects.toThrow(/supersedes/);
  });

  it('save without supersedes emits no superseded acknowledgment', async () => {
    const res = await handleMemoryAction(
      mockMemoryClient(),
      'save',
      { type: 'gotcha', title: 'X', content: 'Y' },
      ctxWith(makeStore(), TEAM),
    );
    expect(res.content[0].text.toLowerCase()).not.toContain('superseded');
  });
});
