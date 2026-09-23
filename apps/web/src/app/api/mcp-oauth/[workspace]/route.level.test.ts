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
