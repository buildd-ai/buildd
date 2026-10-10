/**
 * The OAuth MCP endpoint acts at the level authenticateApiKey resolves for the
 * session — the caller's team role — so admin-only actions follow that role.
 *
 * The real action handlers (and so the real requireAdminLevel gate) are used;
 * only the database, knowledge store and auth resolution are stubbed.
 *
 * Run: bun run scripts/run-unit-tests.ts "apps/web/src/app/api/mcp-oauth/[workspace]/route.level.test.ts"
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import * as realMcpTools from '@buildd/core/mcp-tools';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const mockVerifyAccessToken = mock(() => Promise.resolve({ sub: 'u-1', workspace_id: WORKSPACE_ID } as any));
const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockWorkspacesFindFirst = mock(() =>
  Promise.resolve({ id: WORKSPACE_ID, teamId: TEAM_ID, dataClass: 'standard', repo: 'owner/repo', name: 'ws' } as any),
);
const mockHandleMemoryAction = mock(async () => ({ content: [{ type: 'text', text: 'MEMORY_OK' }] }));

mock.module('@/lib/oauth/tokens', () => ({ verifyAccessToken: mockVerifyAccessToken }));
mock.module('@/lib/oauth/config', () => ({ getIssuer: () => 'https://buildd.dev' }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/memory-helper', () => ({ getMemoryStoreForTeam: async () => ({}) }));

mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: mockWorkspacesFindFirst } } },
}));

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class {},
  getVoyageEmbedder: () => null,
  getVoyageReranker: () => null,
}));

// Real action lists and the real handleBuilddAction (with its admin gate);
// only the memory handler is stubbed so an allowed call is observable.
mock.module('@buildd/core/mcp-tools', () => ({
  ...realMcpTools,
  handleMemoryAction: mockHandleMemoryAction,
}));

const mockTouchInteractiveWorkers = mock((_opts: { accountId: string; userId?: string | null; level: string }) => {});
mock.module('@/lib/interactive-worker-liveness', () => ({
  scheduleInteractiveTouch: mockTouchInteractiveWorkers,
}));

import { POST } from './route';

function rpc(method: string, params?: unknown) {
  return new Request(`http://localhost/api/mcp-oauth/${WORKSPACE_ID}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer aaa.bbb.ccc',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await POST(rpc('tools/call', { name, arguments: args }), {
    params: Promise.resolve({ workspace: WORKSPACE_ID }),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* non-JSON (401) */ }
  return { status: res.status, body };
}

function sessionAt(level: 'worker' | 'admin') {
  mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: TEAM_ID, level, authType: 'oauth' });
}

describe('mcp-oauth route: session level follows the team role', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockHandleMemoryAction.mockClear();
  });

  it('refuses an admin-only buildd action for a member session (worker level)', async () => {
    sessionAt('worker');
    const { body } = await callTool('buildd', { action: 'manage_secrets', params: { action: 'list' } });
    const payload = JSON.parse(body.result.content[0].text);
    expect(body.result.isError).toBe(true);
    expect(payload.error).toBe('forbidden');
    expect(payload.requiredLevel).toBe('admin');
    expect(payload.tokenLevel).toBe('worker');
  });

  for (const action of ['memory_delete', 'consolidate_knowledge'] as const) {
    it(`refuses ${action} for a member session without touching the memory store`, async () => {
      sessionAt('worker');
      const { body } = await callTool('buildd', { action, params: { id: 'm-1' } });
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.error).toBe('forbidden');
      expect(payload.requiredLevel).toBe('admin');
      expect(mockHandleMemoryAction).not.toHaveBeenCalled();
    });
  }

  it('allows memory_delete for an admin session', async () => {
    sessionAt('admin');
    const { body } = await callTool('buildd', { action: 'memory_delete', params: { id: 'm-1' } });
    expect(body.result.content[0].text).toBe('MEMORY_OK');
    expect(mockHandleMemoryAction).toHaveBeenCalledTimes(1);
  });

  it('answers 401 when the session no longer resolves (e.g. membership removed)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const { status } = await callTool('buildd', { action: 'list_tasks', params: {} });
    expect(status).toBe(401);
  });

  it('resolves the session from the same bearer the request carried', async () => {
    sessionAt('admin');
    await callTool('buildd', { action: 'memory_delete', params: { id: 'm-1' } });
    expect(mockAuthenticateApiKey).toHaveBeenCalledWith('aaa.bbb.ccc');
  });
});

// Friction 92866723: the OAuth transport is liveness for interactive workers too.
describe('mcp-oauth route: interactive worker liveness', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockTouchInteractiveWorkers.mockClear();
  });

  it("touches the session account's interactive workers on each call", async () => {
    sessionAt('admin');
    await callTool('buildd', { action: 'memory_delete', params: { id: 'm-1' } });
    expect(mockTouchInteractiveWorkers).toHaveBeenCalledTimes(1);
    expect(mockTouchInteractiveWorkers.mock.calls[0][0]).toMatchObject({ accountId: 'acct-1', userId: 'u-1', level: 'admin' });
  });

  it('touches nothing when the session does not resolve', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    await callTool('buildd', { action: 'list_tasks', params: {} });
    expect(mockTouchInteractiveWorkers).not.toHaveBeenCalled();
  });

  // Two OAuth sessions of one user must not share an identity: the busy one
  // kept every abandoned claim of the other alive.
  it('mints a session id, and a later request echoing it touches as that session only', async () => {
    process.env.AUTH_SECRET = 'test-secret';
    sessionAt('admin');
    const first = await POST(rpc('tools/call', { name: 'buildd', arguments: { action: 'list_tasks', params: {} } }), {
      params: Promise.resolve({ workspace: WORKSPACE_ID }),
    });
    const sid = first.headers.get('mcp-session-id');
    expect(sid).toMatch(/^s1\./);
    expect(mockTouchInteractiveWorkers.mock.calls[0][0]).toMatchObject({ sessionKey: null });

    const req = rpc('tools/call', { name: 'buildd', arguments: { action: 'list_tasks', params: {} } });
    req.headers.set('mcp-session-id', sid!);
    await POST(req, { params: Promise.resolve({ workspace: WORKSPACE_ID }) });
    expect(mockTouchInteractiveWorkers.mock.calls[1][0]).toMatchObject({ sessionKey: sid!.split('.')[1] });
  });
});

// Task 11fe4d38: the internal REST calls carry the caller's bearer, so they go
// to this server's own configured origin, never a hardcoded host.
describe('mcp-oauth route: self-call origin', () => {
  const KEYS = ['VERCEL_URL', 'NEXTAUTH_URL', 'AUTH_URL', 'NODE_ENV'] as const;
  let saved: Record<string, string | undefined>;
  let realFetch: typeof fetch;
  let urls: string[];
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    realFetch = globalThis.fetch;
    urls = [];
    globalThis.fetch = (async (url: any) => { urls.push(String(url)); return new Response('{"tasks":[]}', { status: 200 }); }) as any;
    mockAuthenticateApiKey.mockReset();
    sessionAt('admin');
  });
  const restore = () => {
    globalThis.fetch = realFetch;
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  };

  it('refuses with a 500 config error and makes no outbound call when no origin is configured', async () => {
    try {
      process.env.NODE_ENV = 'production';
      const { status, body } = await callTool('buildd', { action: 'list_tasks', params: {} });
      expect(status).toBe(500);
      expect(body.error).toBe('self_origin_unconfigured');
      expect(urls).toEqual([]);
    } finally { restore(); }
  });

  it('calls the NEXTAUTH_URL origin when it is set', async () => {
    try {
      process.env.NODE_ENV = 'production';
      process.env.NEXTAUTH_URL = 'https://self.example';
      const { status } = await callTool('buildd', { action: 'list_tasks', params: {} });
      expect(status).toBe(200);
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(u.startsWith('https://self.example/api/')).toBe(true);
    } finally { restore(); }
  });
});
