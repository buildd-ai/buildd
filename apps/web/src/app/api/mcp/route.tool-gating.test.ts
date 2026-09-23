/**
 * Gates in the remote MCP route that decide what a caller may see and do:
 *
 * 1. Workspace data class. A `sensitive` workspace is not offered the knowledge
 *    tools at all, and the data-class lookup is fail-closed — if the lookup
 *    itself fails, the workspace is treated as sensitive rather than exposed.
 * 2. Token level. consolidate_knowledge / memory_delete require an admin token.
 * 3. OAuth workspace ambiguity. An OAuth token that reaches several workspaces
 *    and pins none is refused, never silently pointed at the account's team.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as realMcpTools from '@buildd/core/mcp-tools';
import { PgDialect } from 'drizzle-orm/pg-core';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_ID = 'team-1';

// ── Mocks must be declared before importing the route ───────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
// Rows returned by any `db.select().from().where().limit()` — used by the
// "does this caller reach a sensitive workspace" lookup.
const mockSelectLimit = mock(() => Promise.resolve([] as any[]));
const selectWheres: unknown[] = [];
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));
const mockGetMemoryStoreForTeam = mock(() => Promise.resolve(null as any));
const mockHandleMemoryAction = mock(async () => ({ content: [{ type: 'text', text: '{"handled":true}' }] }));
const mockHandleRecallAction = mock(async () => ({ content: [{ type: 'text', text: '{"recalled":true}' }] }));
const mockHandleLearnAction = mock(async () => ({ content: [{ type: 'text', text: '{"learned":true}' }] }));
const mockHandleBuilddAction = mock(async () => ({ content: [{ type: 'text', text: '{"dispatched":true}' }] }));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      accountWorkspaces: {
        findFirst: mock(() => Promise.resolve(null)),
        findMany: mock(() => Promise.resolve([])),
      },
      teams: { findFirst: mock(() => Promise.resolve(null)) },
      workers: { findFirst: mock(() => Promise.resolve(null)) },
      tasks: { findFirst: mock(() => Promise.resolve(null)) },
    },
    update: mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve([])) })) })),
    insert: mock(() => ({ values: mock(() => Promise.resolve([])) })),
    select: mock(() => ({
      from: mock(() => ({ where: mock((w: unknown) => { selectWheres.push(w); return { limit: mockSelectLimit }; }) })),
    })),
  },
}));

mock.module('@buildd/core/path-claim', () => ({
  checkPathClaimConflict: mock(async () => null),
  insertClaims: mock(async () => []),
  registerWaiter: mock(async () => ({ registered: true })),
}));

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class {
    upsert() { return Promise.resolve([]); }
    search() { return Promise.resolve([]); }
  },
  getVoyageEmbedder: () => null,
  getVoyageReranker: () => null,
}));

mock.module('@buildd/core/memory-store', () => ({
  MemoryStore: class {},
}));

mock.module('@/lib/memory-helper', () => ({
  getMemoryStoreForTeam: mockGetMemoryStoreForTeam,
}));

// Keep the real action lists and tool descriptors — only the handlers are stubbed,
// so tool names and level filtering are asserted against production data.
mock.module('@buildd/core/mcp-tools', () => ({
  ...realMcpTools,
  handleBuilddAction: mockHandleBuilddAction,
  handleMemoryAction: mockHandleMemoryAction,
  handleRecallAction: mockHandleRecallAction,
  handleLearnAction: mockHandleLearnAction,
}));

import { POST } from './route';

// ── Helpers ──────────────────────────────────────────────────────────────────

type Account = {
  level: 'trigger' | 'worker' | 'admin';
  authType: 'api' | 'oauth';
  teamId?: string;
};

function makeRequest(body: unknown, query = '') {
  return new Request(`http://localhost/api/mcp${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      Authorization: 'Bearer bld_test',
    },
    body: JSON.stringify(body),
  });
}

async function listTools(query = ''): Promise<string[]> {
  const res = await POST(makeRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, query));
  const body: any = await res.json();
  return (body.result?.tools ?? []).map((t: any) => t.name);
}

async function callTool(name: string, args: unknown, query = ''): Promise<any> {
  const res = await POST(
    makeRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, query),
  );
  const body: any = await res.json();
  return body.result;
}

function authenticateAs({ level, authType, teamId = TEAM_ID }: Account) {
  mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level, teamId, authType });
}

const KNOWLEDGE_TOOLS = ['buildd_memory', 'recall', 'learn'];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MCP tool gating — workspace data class', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockHandleRecallAction.mockClear();
    authenticateAs({ level: 'worker', authType: 'api' });
  });

  it('offers the knowledge tools for a standard workspace', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass: 'standard', teamId: TEAM_ID });

    const names = await listTools(`?workspace=${WORKSPACE_ID}`);
    for (const tool of KNOWLEDGE_TOOLS) expect(names).toContain(tool);
  });

  it('withholds the knowledge tools for a sensitive workspace', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass: 'sensitive', teamId: TEAM_ID });

    const names = await listTools(`?workspace=${WORKSPACE_ID}`);
    for (const tool of KNOWLEDGE_TOOLS) expect(names).not.toContain(tool);
    // Task coordination is unaffected — the data class gates knowledge only.
    expect(names).toContain('buildd');
  });

  it('withholds the knowledge tools when the data-class lookup fails (fail-closed)', async () => {
    // A workspace whose data class cannot be read must be treated as sensitive.
    // Defaulting to 'standard' here would expose team knowledge to exactly the
    // workspaces that opted out of it, and only while the database is unhappy —
    // which is why resolveWorkspaceDataClass is fail-closed.
    // The request-scope check (teamId only) succeeds; the data-class read fails.
    mockWorkspacesFindFirst.mockImplementation(async (opts: any) => {
      if (opts?.columns?.dataClass) throw new Error('connection terminated');
      return { teamId: TEAM_ID };
    });

    const names = await listTools(`?workspace=${WORKSPACE_ID}`);
    for (const tool of KNOWLEDGE_TOOLS) expect(names).not.toContain(tool);
    expect(names).toContain('buildd');
  });

  it('refuses a knowledge tool call in a sensitive workspace even if it was somehow invoked', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass: 'sensitive', teamId: TEAM_ID });

    const result = await callTool('recall', { query: 'anything' }, `?workspace=${WORKSPACE_ID}`);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('sensitive');
    expect(mockHandleRecallAction).not.toHaveBeenCalled();
  });
});

describe('MCP tool gating — admin-only knowledge management', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGetMemoryStoreForTeam.mockReset();
    mockHandleMemoryAction.mockClear();
    mockWorkspacesFindFirst.mockResolvedValue({
      dataClass: 'standard',
      teamId: TEAM_ID,
      repo: 'owner/repo',
      name: 'workspace',
    });
    mockGetMemoryStoreForTeam.mockResolvedValue({ id: 'store-1' });
  });

  for (const action of ['memory_delete', 'consolidate_knowledge']) {
    it(`refuses ${action} for a non-admin token`, async () => {
      authenticateAs({ level: 'worker', authType: 'api' });

      const result = await callTool('buildd', { action, params: {} }, `?workspace=${WORKSPACE_ID}`);
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toBe('forbidden');
      expect(payload.tokenLevel).toBe('worker');
      expect(payload.requiredLevel).toBe('admin');
      expect(mockHandleMemoryAction).not.toHaveBeenCalled();
    });
  }

  it('refuses memory_delete for a trigger token', async () => {
    authenticateAs({ level: 'trigger', authType: 'api' });

    const result = await callTool('buildd', { action: 'memory_delete', params: {} }, `?workspace=${WORKSPACE_ID}`);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBe('forbidden');
    expect(payload.tokenLevel).toBe('trigger');
    expect(mockHandleMemoryAction).not.toHaveBeenCalled();
  });

  it('allows memory_delete for an admin token', async () => {
    authenticateAs({ level: 'admin', authType: 'api' });

    const result = await callTool('buildd', { action: 'memory_delete', params: { id: 'mem-1' } }, `?workspace=${WORKSPACE_ID}`);
    expect(result.isError).toBeUndefined();
    expect(mockHandleMemoryAction).toHaveBeenCalled();
    // memory_delete is dispatched as the store's 'delete' op.
    expect(mockHandleMemoryAction.mock.calls[0][1]).toBe('delete');
  });

  it('allows consolidate_knowledge for an admin token even with no memory store', async () => {
    // consolidate works off the vector store, so a missing memory store is not fatal.
    authenticateAs({ level: 'admin', authType: 'api' });
    mockGetMemoryStoreForTeam.mockResolvedValue(null);

    const result = await callTool('buildd', { action: 'consolidate_knowledge', params: {} }, `?workspace=${WORKSPACE_ID}`);
    expect(result.isError).toBeUndefined();
    expect(mockHandleMemoryAction.mock.calls[0][1]).toBe('consolidate_knowledge');
  });
});

describe('MCP tool gating — OAuth workspace ambiguity', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGetMemoryStoreForTeam.mockReset();
    mockHandleMemoryAction.mockClear();
    mockHandleRecallAction.mockClear();
    mockHandleLearnAction.mockClear();
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass: 'standard', teamId: TEAM_ID, repo: null, name: 'ws' });
    mockGetMemoryStoreForTeam.mockResolvedValue({ id: 'store-1' });
    // No workspace can be inferred from the account's tasks.
    globalThis.fetch = mock(() => Promise.reject(new Error('no network in unit tests'))) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  for (const [tool, args] of [
    ['buildd_memory', { action: 'save', params: { content: 'x' } }],
    ['recall', { query: 'x' }],
    ['learn', { type: 'gotcha', title: 't', content: 'c' }],
  ] as const) {
    it(`refuses ${tool} for an OAuth token with no resolvable workspace`, async () => {
      authenticateAs({ level: 'worker', authType: 'oauth' });

      const result = await callTool(tool, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot resolve workspace');
      expect(result.content[0].text).toContain('?workspace=');
      // The point of the guard: no fallback to the account's team, so the
      // store for a workspace the caller never named is never even opened.
      expect(mockGetMemoryStoreForTeam).not.toHaveBeenCalled();
      expect(mockHandleMemoryAction).not.toHaveBeenCalled();
      expect(mockHandleRecallAction).not.toHaveBeenCalled();
      expect(mockHandleLearnAction).not.toHaveBeenCalled();
    });
  }

  it('refuses admin knowledge management for an OAuth token with no resolvable workspace', async () => {
    authenticateAs({ level: 'admin', authType: 'oauth' });

    const result = await callTool('buildd', { action: 'memory_delete', params: { id: 'mem-1' } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot resolve workspace');
    expect(mockHandleMemoryAction).not.toHaveBeenCalled();
  });

  it('proceeds for an OAuth token that pins a workspace', async () => {
    authenticateAs({ level: 'worker', authType: 'oauth' });

    const result = await callTool('recall', { query: 'x' }, `?workspace=${WORKSPACE_ID}`);
    expect(result.isError).toBeUndefined();
    expect(mockHandleRecallAction).toHaveBeenCalled();
  });

  it('does not apply the ambiguity guard to an API-key token', async () => {
    // API keys are scoped to one account/team, so there is no misroute risk and
    // an unpinned workspace stays allowed.
    authenticateAs({ level: 'worker', authType: 'api' });

    const result = await callTool('recall', { query: 'x' });
    expect(result.isError).toBeUndefined();
    expect(mockHandleRecallAction).toHaveBeenCalled();
  });
});

describe('MCP tool gating — lazily resolved workspace', () => {
  // No ?workspace= / ?repo= pin: the route infers the workspace from the
  // account's own tasks. The data-class gate must apply to that inferred
  // workspace just as it does to a pinned one.
  const LAZY_WS = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const realFetch = globalThis.fetch;

  function workspaceIs(dataClass: 'standard' | 'sensitive') {
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass, teamId: TEAM_ID, repo: null, name: 'ws' });
  }

  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGetMemoryStoreForTeam.mockReset();
    mockHandleMemoryAction.mockClear();
    mockHandleRecallAction.mockClear();
    mockHandleLearnAction.mockClear();
    mockHandleBuilddAction.mockClear();
    mockGetMemoryStoreForTeam.mockResolvedValue({ id: 'store-1' });
    authenticateAs({ level: 'worker', authType: 'api' });
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ tasks: [{ id: 't1', workspaceId: LAZY_WS, status: 'pending' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as any;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  for (const [tool, args] of [
    ['recall', { query: 'x' }],
    ['learn', { type: 'gotcha', title: 't', content: 'c' }],
    ['buildd_memory', { action: 'search', params: { query: 'x' } }],
  ] as const) {
    it(`refuses ${tool} when the inferred workspace is sensitive`, async () => {
      workspaceIs('sensitive');

      const result = await callTool(tool, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not available in sensitive workspaces');
      expect(mockGetMemoryStoreForTeam).not.toHaveBeenCalled();
      expect(mockHandleMemoryAction).not.toHaveBeenCalled();
      expect(mockHandleRecallAction).not.toHaveBeenCalled();
      expect(mockHandleLearnAction).not.toHaveBeenCalled();
    });
  }

  it('still serves recall when the inferred workspace is standard', async () => {
    workspaceIs('standard');

    const result = await callTool('recall', { query: 'x' });
    expect(result.isError).toBeUndefined();
    expect(mockHandleRecallAction).toHaveBeenCalled();
  });

  it('does not read the workspace memory resource for an inferred sensitive workspace', async () => {
    workspaceIs('sensitive');

    await POST(makeRequest({
      jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'buildd://workspace/memory' },
    }));
    expect(mockGetMemoryStoreForTeam).not.toHaveBeenCalled();
  });

  it('does not read the workspace memory resource for a pinned sensitive workspace', async () => {
    workspaceIs('sensitive');

    await POST(makeRequest({
      jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'buildd://workspace/memory' },
    }, `?workspace=${WORKSPACE_ID}`));
    expect(mockGetMemoryStoreForTeam).not.toHaveBeenCalled();
  });

  it('gives buildd actions no memory client for an inferred sensitive workspace', async () => {
    workspaceIs('sensitive');

    await callTool('buildd', { action: 'list_tasks', params: {} });
    expect(mockHandleBuilddAction).toHaveBeenCalled();
    const ctx: any = (mockHandleBuilddAction.mock.calls[0] as any[])[3];
    // Resolve the workspace the way a claim would, then ask for memory.
    await ctx.getWorkspaceId();
    expect(await ctx.getMemoryClient()).toBeNull();
    expect(mockGetMemoryStoreForTeam).not.toHaveBeenCalled();
  });

  // claim_task resolves its own workspace (an explicit id, or any workspace the
  // account can claim from), which the connection never learns. On an unpinned
  // connection the memory client is therefore withheld whenever the caller
  // can reach a sensitive workspace at all.
  it('gives a claim on an unpinned connection no memory client when the caller reaches a sensitive workspace', async () => {
    workspaceIs('standard');
    mockSelectLimit.mockResolvedValueOnce([{ id: WORKSPACE_ID }]);

    await callTool('buildd', { action: 'claim_task', params: { workspaceId: WORKSPACE_ID } });
    const ctx: any = (mockHandleBuilddAction.mock.calls[0] as any[])[3];
    // Exactly what claim_task does with an explicit UUID: no getWorkspaceId().
    expect(await ctx.getMemoryClient()).toBeNull();
    expect(mockGetMemoryStoreForTeam).not.toHaveBeenCalled();
  });

  it("scopes the sensitive-reach lookup to sensitive workspaces of the caller's team", async () => {
    workspaceIs('standard');
    selectWheres.length = 0;

    await callTool('buildd', { action: 'claim_task', params: {} });
    const ctx: any = (mockHandleBuilddAction.mock.calls[0] as any[])[3];
    await ctx.getMemoryClient();
    expect(selectWheres.length).toBe(1);
    const q = new PgDialect().sqlToQuery(selectWheres[0] as any);
    expect(q.sql).toContain('"data_class"');
    expect(q.sql).toContain('"team_id"');
    expect(q.params).toContain('sensitive');
    expect(q.params).toContain(TEAM_ID);
  });

  it('withholds the memory client when the sensitive-reach lookup fails', async () => {
    workspaceIs('standard');
    mockSelectLimit.mockRejectedValueOnce(new Error('db down'));

    await callTool('buildd', { action: 'claim_task', params: {} });
    const ctx: any = (mockHandleBuilddAction.mock.calls[0] as any[])[3];
    expect(await ctx.getMemoryClient()).toBeNull();
  });

  it('keeps the memory client for a claim when the caller reaches no sensitive workspace', async () => {
    workspaceIs('standard');

    await callTool('buildd', { action: 'claim_task', params: { workspaceId: WORKSPACE_ID } });
    const ctx: any = (mockHandleBuilddAction.mock.calls[0] as any[])[3];
    expect(await ctx.getMemoryClient()).toEqual({ id: 'store-1' });
  });

  it('gives buildd actions a memory client for an inferred standard workspace', async () => {
    workspaceIs('standard');

    await callTool('buildd', { action: 'list_tasks', params: {} });
    const ctx: any = (mockHandleBuilddAction.mock.calls[0] as any[])[3];
    await ctx.getWorkspaceId();
    expect(await ctx.getMemoryClient()).toEqual({ id: 'store-1' });
  });
});
