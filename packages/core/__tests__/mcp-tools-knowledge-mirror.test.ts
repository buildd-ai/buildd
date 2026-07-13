import { describe, it, expect, beforeEach } from 'bun:test';
import { handleBuilddAction, handleMemoryAction, type ApiFn, type ActionContext } from '../mcp-tools';
import type { KnowledgeStore, UpsertChunk } from '../knowledge-store/types';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const MOCK_TEAM_ID = '00000000-0000-0000-0000-0000000000aa';

// ── Mock KnowledgeStore that records upserts ─────────────────────────────────

function makeRecordingStore(): KnowledgeStore & {
  upserts: Array<{ namespace: string; chunks: UpsertChunk[] }>;
} {
  const upserts: Array<{ namespace: string; chunks: UpsertChunk[] }> = [];
  return {
    upserts,
    async upsert(namespace, chunks) {
      upserts.push({ namespace, chunks });
    },
    async query() {
      return [];
    },
    async delete() {},
    async listNamespaces() {
      return [];
    },
  };
}

function makeThrowingStore(): KnowledgeStore {
  return {
    async upsert() {
      throw new Error('store is down');
    },
    async query() {
      return [];
    },
    async delete() {},
    async listNamespaces() {
      return [];
    },
  };
}

function ctxWith(store: KnowledgeStore, level: 'worker' | 'admin' = 'worker'): ActionContext {
  return {
    workerId: 'w-1',
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => level,
    knowledgeStore: store,
    embedder: null,
  };
}

// Routes mock-api responses by endpoint + method.
function routedApi(routes: Record<string, any>): ApiFn {
  return (async (endpoint: string, opts?: any) => {
    const method = opts?.method ?? 'GET';
    const key = `${method} ${endpoint}`;
    // exact match first, then prefix match
    if (key in routes) return routes[key];
    for (const [k, v] of Object.entries(routes)) {
      if (key.startsWith(k)) return v;
    }
    return {};
  }) as ApiFn;
}

describe('knowledge mirror — complete_task', () => {
  it('upserts a task card on success', async () => {
    const store = makeRecordingStore();
    const api = routedApi({
      'PATCH /api/workers/w-1': { turns: 3 },
      'GET /api/workers/w-1': { taskId: 't-1' },
      'GET /api/tasks/t-1': {
        title: 'Fix bug',
        description: 'desc',
        missionId: 'm-1',
        prUrl: 'https://gh/pr/1',
        result: { summary: 'done' },
      },
    });

    await handleBuilddAction(api, 'complete_task', { summary: 'done', nextSuggestion: 'follow up on X' }, ctxWith(store));

    // Two mirrors: the durable task card and the recency-weighted session card.
    expect(store.upserts).toHaveLength(2);

    const task = store.upserts.find(u => u.namespace === `${MOCK_WORKSPACE_ID}:task`);
    expect(task).toBeDefined();
    expect(task!.chunks[0].id).toBe('task:t-1');
    expect(task!.chunks[0].metadata?.phase).toBe('outcome');
    expect(task!.chunks[0].metadata?.missionId).toBe('m-1');
    expect(task!.chunks[0].content).toContain('done');

    const session = store.upserts.find(u => u.namespace === `${MOCK_WORKSPACE_ID}:session`);
    expect(session).toBeDefined();
    expect(session!.chunks[0].id).toBe('session:t-1');
    expect(session!.chunks[0].metadata?.phase).toBe('session');
    expect(session!.chunks[0].metadata?.missionId).toBe('m-1');
    expect(session!.chunks[0].content).toContain('done');
    expect(session!.chunks[0].content).toContain('follow up on X');
  });

  it('does NOT fail the action when the store throws', async () => {
    const api = routedApi({
      'PATCH /api/workers/w-1': { turns: 1 },
      'GET /api/workers/w-1': { taskId: 't-1' },
      'GET /api/tasks/t-1': { title: 'X' },
    });

    const res = await handleBuilddAction(
      api,
      'complete_task',
      { summary: 'ok' },
      ctxWith(makeThrowingStore()),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('completed successfully');
  });
});

describe('knowledge mirror — create_pr', () => {
  it('upserts a pr card', async () => {
    const store = makeRecordingStore();
    const api = routedApi({
      'POST /api/github/pr': { pr: { number: 7, title: 'feat: x', url: 'https://gh/pr/7', state: 'open' } },
      'GET /api/workers/w-1': { taskId: 't-1', task: { missionId: 'm-1' } },
    });

    await handleBuilddAction(
      api,
      'create_pr',
      { title: 'feat: x', head: 'feature', body: 'the body' },
      ctxWith(store),
    );

    expect(store.upserts).toHaveLength(1);
    const { namespace, chunks } = store.upserts[0];
    expect(namespace).toBe(`${MOCK_WORKSPACE_ID}:pr`);
    expect(chunks[0].id).toBe('pr:7');
    expect(chunks[0].metadata?.phase).toBe('implementation');
    expect(chunks[0].metadata?.taskId).toBe('t-1');
    expect(chunks[0].content).toContain('the body');
  });

  it('does NOT fail the action when the store throws', async () => {
    const api = routedApi({
      'POST /api/github/pr': { pr: { number: 7, title: 'feat: x', url: 'https://gh/pr/7', state: 'open' } },
      'GET /api/workers/w-1': { taskId: 't-1' },
    });
    const res = await handleBuilddAction(
      api,
      'create_pr',
      { title: 'feat: x', head: 'feature' },
      ctxWith(makeThrowingStore()),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Pull request created');
  });
});

describe('knowledge mirror — create_artifact', () => {
  it('upserts an artifact card', async () => {
    const store = makeRecordingStore();
    const api = routedApi({
      'POST /api/workers/w-1/artifacts': {
        artifact: { id: 'a-3', title: 'Summary', type: 'summary', shareUrl: 'https://buildd/s/a-3' },
      },
    });

    await handleBuilddAction(
      api,
      'create_artifact',
      { type: 'summary', title: 'Summary', content: 'artifact body' },
      ctxWith(store),
    );

    expect(store.upserts).toHaveLength(1);
    const { namespace, chunks } = store.upserts[0];
    expect(namespace).toBe(`${MOCK_WORKSPACE_ID}:artifact`);
    expect(chunks[0].id).toBe('artifact:a-3');
    expect(chunks[0].content).toContain('artifact body');
    expect(chunks[0].sourceUrl).toBe('https://buildd/s/a-3');
  });

  it('does NOT fail the action when the store throws', async () => {
    const api = routedApi({
      'POST /api/workers/w-1/artifacts': {
        artifact: { id: 'a-3', title: 'Summary', type: 'summary', shareUrl: 'x' },
      },
    });
    const res = await handleBuilddAction(
      api,
      'create_artifact',
      { type: 'summary', title: 'Summary', content: 'body' },
      ctxWith(makeThrowingStore()),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Artifact created');
  });
});

describe('knowledge mirror — approve_plan', () => {
  it('upserts a plan card with rendered steps', async () => {
    const store = makeRecordingStore();
    const api = routedApi({
      'POST /api/tasks/t-9/approve-plan': { tasks: ['c-1', 'c-2'] },
      'GET /api/tasks/t-9': {
        title: 'Build feature',
        missionId: 'm-1',
        result: {
          structuredOutput: {
            plan: [
              { ref: 'A', title: 'Build API', description: 'endpoints' },
              { ref: 'B', title: 'Wire UI', dependsOn: ['A'] },
            ],
          },
        },
      },
    });

    await handleBuilddAction(api, 'approve_plan', { taskId: 't-9' }, ctxWith(store, 'admin'));

    expect(store.upserts).toHaveLength(1);
    const { namespace, chunks } = store.upserts[0];
    expect(namespace).toBe(`${MOCK_WORKSPACE_ID}:plan`);
    expect(chunks[0].id).toBe('plan:t-9');
    expect(chunks[0].metadata?.phase).toBe('plan');
    expect(chunks[0].content).toContain('Build API');
    expect(chunks[0].content).toContain('Wire UI');
  });

  it('does NOT fail the action when the store throws', async () => {
    const api = routedApi({
      'POST /api/tasks/t-9/approve-plan': { tasks: ['c-1'] },
      'GET /api/tasks/t-9': {
        result: { structuredOutput: { plan: [{ ref: 'A', title: 'X' }] } },
      },
    });
    const res = await handleBuilddAction(
      api,
      'approve_plan',
      { taskId: 't-9' },
      ctxWith(makeThrowingStore(), 'admin'),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Plan approved');
  });
});

describe('knowledge mirror — no store configured', () => {
  it('is a no-op when knowledgeStore is absent', async () => {
    const api = routedApi({
      'POST /api/workers/w-1/artifacts': {
        artifact: { id: 'a-1', title: 'T', type: 'summary', shareUrl: 'x' },
      },
    });
    const ctx: ActionContext = {
      workerId: 'w-1',
      workspaceId: MOCK_WORKSPACE_ID,
      getWorkspaceId: async () => MOCK_WORKSPACE_ID,
      getLevel: async () => 'worker',
    };
    const res = await handleBuilddAction(api, 'create_artifact', { type: 'summary', title: 'T' }, ctx);
    expect(res.isError).toBeFalsy();
  });
});

// ── memory corpus is team-scoped (regression for workspace-namespace bug) ────

function mockMemoryClient(): any {
  const mem = (over: any = {}) => ({ id: 'mem-1', title: 'T', content: 'C', type: 'gotcha', tags: [], files: [], project: null, ...over });
  return {
    async save(input: any) { return { memory: mem(input) }; },
    async update(_id: string, fields: any) { return { memory: mem(fields) }; },
    async delete() {},
  };
}

describe('knowledge mirror — memory is team-scoped', () => {
  it('save upserts to {teamId}:memory, never the workspace namespace', async () => {
    const store = makeRecordingStore();
    const ctx: ActionContext = {
      workspaceId: MOCK_WORKSPACE_ID,
      teamId: MOCK_TEAM_ID,
      getWorkspaceId: async () => MOCK_WORKSPACE_ID,
      getLevel: async () => 'worker',
      knowledgeStore: store,
      embedder: null,
    };
    await handleMemoryAction(mockMemoryClient(), 'save', { type: 'gotcha', title: 'X', content: 'Y' }, ctx);
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0].namespace).toBe(`${MOCK_TEAM_ID}:memory`);
    expect(store.upserts[0].namespace).not.toContain(MOCK_WORKSPACE_ID);
  });

  it('does not mirror memory when teamId is absent (no workspace fallback)', async () => {
    const store = makeRecordingStore();
    const ctx: ActionContext = {
      workspaceId: MOCK_WORKSPACE_ID,
      getWorkspaceId: async () => MOCK_WORKSPACE_ID,
      getLevel: async () => 'worker',
      knowledgeStore: store,
      embedder: null,
    };
    await handleMemoryAction(mockMemoryClient(), 'save', { type: 'gotcha', title: 'X', content: 'Y' }, ctx);
    expect(store.upserts).toHaveLength(0);
  });
});
