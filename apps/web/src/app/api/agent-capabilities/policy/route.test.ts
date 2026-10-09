import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mocks (before importing the route) ────────────────────────────────────────

const mockUser = mock(() => Promise.resolve(null as any));
const mockTeamIds = mock((_u: string) => Promise.resolve([] as string[]));
const mockCan = mock((_c: any, _p: string, _t: string) => Promise.resolve(false));
const mockRules = mock((_t: string) => Promise.resolve([] as any[]));
const mockWorkspace = mock((_q: any) => Promise.resolve(null as any));
const inserted: any[] = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockTeamIds }));
mock.module('@/lib/permissions', () => ({ can: mockCan }));
mock.module('@/lib/capability-grants-store', () => ({ loadPolicyRules: mockRules }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workspaces: { findFirst: mockWorkspace } },
    insert: () => ({
      values: (v: any) => ({
        onConflictDoUpdate: () => ({ returning: async () => { inserted.push(v); return [{ id: 'rule-1', ...v }]; } }),
      }),
    }),
    delete: () => ({ where: () => ({ returning: async () => [{ id: 'x' }] }) }),
  },
}));

import { GET, PUT } from './route';

// ── fixtures (illustrative) ───────────────────────────────────────────────────

const TEAM_A = '77777777-7777-4777-8777-777777777777';
const TEAM_B = '88888888-8888-4888-8888-888888888888';
const WS = '33333333-3333-4333-8333-333333333333';

function req(method: string, body?: unknown, headers: Record<string, string> = {}, qs = '') {
  return new NextRequest(`http://localhost/api/agent-capabilities/policy${qs}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  mockUser.mockReset(); mockTeamIds.mockReset(); mockCan.mockReset(); mockRules.mockReset(); mockWorkspace.mockReset();
  inserted.length = 0;
  mockUser.mockResolvedValue({ id: 'user-1' });
  mockTeamIds.mockResolvedValue([TEAM_A]);
  mockCan.mockResolvedValue(true);
  mockRules.mockResolvedValue([]);
});

describe('/api/agent-capabilities/policy', () => {
  it('a member can read policy but not change it', async () => {
    mockCan.mockResolvedValue(false);
    const get = await GET(req('GET'));
    expect(get.status).toBe(200);
    expect((await get.json()).canManage).toBe(false);
    const put = await PUT(req('PUT', { provider: 'axiom', risk: 'query', effect: 'auto_grant' }));
    expect(put.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('an admin sets a rule, keyed by its scope', async () => {
    mockWorkspace.mockResolvedValue({ teamId: TEAM_A });
    const res = await PUT(req('PUT', { provider: 'axiom', risk: 'query', effect: 'auto_grant', workspaceId: WS, environment: 'Production', maxTtlSeconds: 900 }));
    expect(res.status).toBe(200);
    expect(inserted[0]).toMatchObject({ teamId: TEAM_A, provider: 'axiom', risk: 'query', effect: 'auto_grant', workspaceId: WS, environment: 'production', maxTtlSeconds: 900, updatedByUserId: 'user-1' });
    expect(inserted[0].scopeKey).toBe(`axiom|query|${WS}|*|production|*`);
  });

  it('refuses auto_grant for writes, even from an admin', async () => {
    const res = await PUT(req('PUT', { provider: 'vercel', risk: 'write', effect: 'auto_grant' }));
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it("refuses a rule on another team's workspace", async () => {
    mockWorkspace.mockResolvedValue({ teamId: TEAM_B });
    const res = await PUT(req('PUT', { provider: 'axiom', risk: 'query', effect: 'forbidden', workspaceId: WS }));
    expect(res.status).toBe(404);
  });

  it('refuses any API key, admin or agent', async () => {
    const res = await PUT(req('PUT', { provider: 'axiom', risk: 'read', effect: 'auto_grant' }, { authorization: 'Bearer bld_admin' }));
    expect(res.status).toBe(403);
    expect((await GET(req('GET', undefined, { authorization: 'Bearer bldt_task' }))).status).toBe(403);
  });

  it("another team's id is 404", async () => {
    expect((await GET(req('GET', undefined, {}, `?teamId=${TEAM_B}`))).status).toBe(404);
  });
});
