/**
 * The remote MCP route's group tools (buildd_<group>): what tools/list shows
 * per level and surface, how a group call routes, and that the one-tool
 * `buildd` stays callable on the groups surface, where it is not listed.
 * Groups is the standard surface. The one exception is a runner worker
 * session (`?worker=`) whose runner did not advertise the group-tools
 * capability on its heartbeat: it keeps the legacy one-tool `buildd`.
 */


import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as realMcpTools from '@buildd/core/mcp-tools';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_ID = 'team-1';

// ── Mocks must be declared before importing the route ───────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockHeartbeatsFindFirst = mock(() => Promise.resolve(null as any));
// Rows returned by any `db.select().from().where().limit()` — used by the
// "does this caller reach a sensitive workspace" lookup.
const mockSelectLimit = mock(() => Promise.resolve([] as any[]));
const selectWheres: unknown[] = [];
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));
// The team's sensitive workspaces, as the memory project-key resolver reads them.
const mockWorkspacesFindMany = mock(() => Promise.resolve([] as any[]));
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
      workspaces: { findFirst: mockWorkspacesFindFirst, findMany: mockWorkspacesFindMany },
      accountWorkspaces: {
        findFirst: mock(() => Promise.resolve(null)),
        findMany: mock(() => Promise.resolve([])),
      },
      teams: { findFirst: mock(() => Promise.resolve(null)) },
      workers: { findFirst: mockWorkersFindFirst },
      workerHeartbeats: { findFirst: mockHeartbeatsFindFirst },
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
import { CAPABILITY_MCP_GROUP_TOOLS } from '@buildd/shared';

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

const WORKER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const text = (r: any): string => r.content[0].text;

describe('MCP group tools — tools/list', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass: 'standard', teamId: TEAM_ID });
  });

  it('default: an interactive session (no worker) gets the group tools, no buildd', async () => {
    authenticateAs({ level: 'admin', authType: 'api' });
    const names = await listTools(`?workspace=${WORKSPACE_ID}`);
    for (const t of ['buildd_missions', 'buildd_tasks', 'buildd_work', 'buildd_prs', 'buildd_runners', 'buildd_analytics', 'buildd_artifacts', 'buildd_schedules', 'buildd_admin', 'recall', 'learn', 'check_path_claim', 'send_worker_message']) {
      expect(names).toContain(t);
    }
    expect(names).not.toContain('buildd');
    // The runner-written repo .mcp.json shape (?repo=, no worker) too.
    const repo = await listTools(`?repo=owner/repo`);
    expect(repo).toContain('buildd_tasks');
    expect(repo).not.toContain('buildd');
  });

  it('?tools= is not read: legacy cannot be requested, groups need no opt-in', async () => {
    authenticateAs({ level: 'admin', authType: 'api' });
    const names = await listTools(`?workspace=${WORKSPACE_ID}&tools=legacy`);
    expect(names).toContain('buildd_work');
    expect(names).not.toContain('buildd');
  });

  it('trigger: only the groups it has actions in', async () => {
    authenticateAs({ level: 'trigger', authType: 'api' });
    const names = (await listTools(`?workspace=${WORKSPACE_ID}`)).filter(n => n.startsWith('buildd'));
    expect(names.sort()).toEqual(['buildd_artifacts', 'buildd_schedules', 'buildd_tasks', 'buildd_work']);
  });

  it('a worker session whose runner advertises group tools gets them', async () => {
    authenticateAs({ level: 'worker', authType: 'api' });
    mockWorkersFindFirst.mockResolvedValue({ accountId: 'acc-1', localUiUrl: 'http://runner.local:8766' });
    mockHeartbeatsFindFirst.mockResolvedValue({ environment: { envKeys: ['backend:codex', CAPABILITY_MCP_GROUP_TOOLS] } });
    const names = await listTools(`?workspace=${WORKSPACE_ID}&worker=${WORKER_ID}`);
    expect(names).toContain('buildd_work');
    expect(names).not.toContain('buildd');
  });

  it('a worker session whose runner predates group tools keeps the legacy buildd tool', async () => {
    authenticateAs({ level: 'worker', authType: 'api' });
    mockWorkersFindFirst.mockResolvedValue({ accountId: 'acc-1', localUiUrl: 'http://runner.local:8766' });
    mockHeartbeatsFindFirst.mockResolvedValue({ environment: { envKeys: ['backend:codex'] } });
    const names = await listTools(`?workspace=${WORKSPACE_ID}&worker=${WORKER_ID}`);
    expect(names).toContain('buildd');
    expect(names).not.toContain('buildd_work');
    // ...and the old opt-in no longer moves it: a runner that cannot match the
    // group tool names must not be served them.
    const opted = await listTools(`?workspace=${WORKSPACE_ID}&worker=${WORKER_ID}&tools=groups`);
    expect(opted).toContain('buildd');
    expect(opted).not.toContain('buildd_work');
  });

  it('a worker session whose runner cannot be identified keeps the legacy buildd tool', async () => {
    authenticateAs({ level: 'worker', authType: 'api' });
    // No local UI URL registered yet, so no heartbeat row to read.
    mockWorkersFindFirst.mockResolvedValue({ accountId: 'acc-1', localUiUrl: null });
    mockHeartbeatsFindFirst.mockResolvedValue({ environment: { envKeys: [CAPABILITY_MCP_GROUP_TOOLS] } });
    expect(await listTools(`?workspace=${WORKSPACE_ID}&worker=${WORKER_ID}`)).toContain('buildd');
    // No heartbeat row.
    mockWorkersFindFirst.mockResolvedValue({ accountId: 'acc-1', localUiUrl: 'http://runner.local:8766' });
    mockHeartbeatsFindFirst.mockResolvedValue(null);
    expect(await listTools(`?workspace=${WORKSPACE_ID}&worker=${WORKER_ID}`)).toContain('buildd');
    // The lookup failing.
    mockHeartbeatsFindFirst.mockRejectedValue(new Error('db down'));
    expect(await listTools(`?workspace=${WORKSPACE_ID}&worker=${WORKER_ID}`)).toContain('buildd');
    mockHeartbeatsFindFirst.mockReset();
  });

  const initialize = async (query: string) => {
    const res = await POST(makeRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }, query));
    const body: any = await res.json();
    return body.result.instructions as string;
  };

  it('initialize carries the groups instructions by default', async () => {
    authenticateAs({ level: 'worker', authType: 'api' });
    const instructions = await initialize(`?workspace=${WORKSPACE_ID}`);
    expect(instructions).toContain('buildd_<group>');
    expect(instructions).toContain('help');
  });

  it('initialize carries the legacy instructions for a worker on a runner that predates group tools', async () => {
    authenticateAs({ level: 'worker', authType: 'api' });
    mockWorkersFindFirst.mockResolvedValue({ accountId: 'acc-1', localUiUrl: 'http://runner.local:8766' });
    mockHeartbeatsFindFirst.mockResolvedValue({ environment: { envKeys: [] } });
    const instructions = await initialize(`?workspace=${WORKSPACE_ID}&worker=${WORKER_ID}`);
    expect(instructions).toContain('Tools: `buildd` (task actions)');
    expect(instructions).not.toContain('buildd_<group>');
  });
});

describe('MCP group tools — tools/call', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockResolvedValue({ dataClass: 'standard', teamId: TEAM_ID, repo: 'owner/repo', name: 'workspace' });
    mockHandleBuilddAction.mockClear();
    mockHandleMemoryAction.mockClear();
    mockGetMemoryStoreForTeam.mockReset();
    mockGetMemoryStoreForTeam.mockResolvedValue({ id: 'store-1' });
    authenticateAs({ level: 'admin', authType: 'api' });
  });

  it('a group tool dispatches its action through handleBuilddAction', async () => {
    const result = await callTool('buildd_missions', { action: 'manage_missions', params: { action: 'list' } }, `?workspace=${WORKSPACE_ID}`);
    expect(text(result)).toBe('{"dispatched":true}');
    const call = mockHandleBuilddAction.mock.calls[0] as unknown[];
    expect(call[1]).toBe('manage_missions');
    expect(call[2]).toEqual({ action: 'list' });
  });

  it('legacy buildd is still callable by action', async () => {
    const result = await callTool('buildd', { action: 'list_runners', params: {} }, `?workspace=${WORKSPACE_ID}`);
    expect(text(result)).toBe('{"dispatched":true}');
    expect((mockHandleBuilddAction.mock.calls[0] as unknown[])[1]).toBe('list_runners');
  });

  it('a wrong-group action above the level is refused without naming an unlisted tool', async () => {
    authenticateAs({ level: 'trigger', authType: 'api' });
    const result = await callTool('buildd_tasks', { action: 'manage_missions', params: {} }, `?workspace=${WORKSPACE_ID}`);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('"manage_missions" is not available at your token level (trigger).');
    expect(mockHandleBuilddAction).not.toHaveBeenCalled();
  });

  it('a wrong-group action gets a one-line error naming the right tool, and nothing runs', async () => {
    const result = await callTool('buildd_missions', { action: 'list_runners', params: {} }, `?workspace=${WORKSPACE_ID}`);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('buildd_analytics');
    expect(text(result).includes('\n')).toBe(false);
    expect(mockHandleBuilddAction).not.toHaveBeenCalled();
  });

  it('help returns the long docs, and nothing runs', async () => {
    const result = await callTool('buildd_work', { action: 'help', params: { action: 'create_pr' } }, `?workspace=${WORKSPACE_ID}`);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('create_pr params:');
    expect(text(result)).toContain('lede');
    expect(mockHandleBuilddAction).not.toHaveBeenCalled();
  });

  it('the admin knowledge actions take the same path through buildd_admin as through buildd', async () => {
    const result = await callTool('buildd_admin', { action: 'memory_delete', params: { id: 'mem-1' } }, `?workspace=${WORKSPACE_ID}`);
    expect(result.isError).toBeUndefined();
    expect((mockHandleMemoryAction.mock.calls[0] as unknown[])[1]).toBe('delete');
  });

  it('a group tool refuses an above-level knowledge action exactly as buildd does', async () => {
    authenticateAs({ level: 'worker', authType: 'api' });
    const viaGroup = await callTool('buildd_admin', { action: 'memory_delete', params: {} }, `?workspace=${WORKSPACE_ID}`);
    const viaBuildd = await callTool('buildd', { action: 'memory_delete', params: {} }, `?workspace=${WORKSPACE_ID}`);
    expect(text(viaGroup)).toBe(text(viaBuildd));
    expect(JSON.parse(text(viaGroup)).error).toBe('forbidden');
  });
});
