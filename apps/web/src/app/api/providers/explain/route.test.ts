import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { providerDescriptor } from '@buildd/core/providers';

const SECRET = 'sk-ant-api03-FIXTURE-explain-secret-value-0000';
const bodies: string[] = [];

let workspaceExists = true;
mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: async () => (workspaceExists ? { id: 'ws-1' } : undefined) } } },
}));
const resolve = mock(async (input: any) => ({
  credential: { provider: 'anthropic', shape: 'api_key', value: SECRET, tokenExpiresAt: null },
  provider: 'anthropic',
  scope: input.requesterUserId ? 'personal' : 'team',
  source: { scope: input.requesterUserId ? 'personal' : 'team', secretId: 'sec-1', purpose: 'anthropic_api_key', label: null, legacy: true },
  why: ['policy: team [from default]', 'team anthropic_api_key sec-1: used (anthropic)'],
}) as any);
mock.module('@buildd/core/providers/resolve', () => ({ resolveProviderCredential: resolve }));

let sessionUser: { id: string } | null = null;
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => sessionUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: async () => ['t-1'], resolveActiveTeamId: async () => 't-1' }));
mock.module('@/lib/permissions', () => ({ can: async () => false }));
const ACCOUNTS: Record<string, any> = {
  bld_worker: { id: 'acc-worker', teamId: 't-1', level: 'worker' },
  bldt_task: { id: 'acc', teamId: 't-1', level: 'worker', taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: 0 } },
};
mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: async (token: string) => ACCOUNTS[token] ?? null,
  taskScopeAllowsWorkspace: (a: any, ws: string | null | undefined) => !a.taskScope || (!!ws && ws === a.taskScope.workspaceId),
}));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: () => false }));

const { GET } = await import('./route');

async function get(url: string, bearer?: string): Promise<{ status: number; body: any }> {
  const res = await GET(new NextRequest(`http://localhost:3000${url}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, body: JSON.parse(text) };
}

beforeEach(() => {
  sessionUser = null;
  workspaceExists = true;
  resolve.mockClear();
});

describe('GET /api/providers/explain', () => {
  it('requires a surface', async () => {
    sessionUser = { id: 'u-1' };
    expect((await get('/api/providers/explain')).status).toBe(400);
  });

  it('422s an impossible provider × surface with the registry string', async () => {
    sessionUser = { id: 'u-1' };
    const { status, body } = await get('/api/providers/explain?surface=agent-codex&provider=anthropic');
    expect(status).toBe(422);
    const support = providerDescriptor('anthropic').surfaces['agent-codex'] as { ok: false; reason: string; instead?: readonly string[] };
    expect(body).toEqual({ error: 'provider_surface_unsupported', provider: 'anthropic', surface: 'agent-codex', reason: support.reason, instead: support.instead });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a person explains their own work by default (the requester is them)', async () => {
    sessionUser = { id: 'u-1' };
    const { status, body } = await get('/api/providers/explain?surface=chat');
    expect(status).toBe(200);
    expect(resolve.mock.calls[0][0]).toMatchObject({ teamId: 't-1', surface: 'chat', requesterUserId: 'u-1', accountId: null, workspaceId: null });
    expect(body.as).toBe('self');
    expect(body.result).toEqual({ resolved: true, provider: 'anthropic', shape: 'api_key', scope: 'personal', source: { scope: 'personal', secretId: 'sec-1', purpose: 'anthropic_api_key', label: null, legacy: true } });
    expect(body.why.length).toBeGreaterThan(0);
  });

  it('as=team resolves team work with no requester', async () => {
    sessionUser = { id: 'u-1' };
    await get('/api/providers/explain?surface=agent-claude&as=team');
    expect(resolve.mock.calls[0][0].requesterUserId).toBeNull();
  });

  it('a key explains team work only; as=self is refused', async () => {
    const team = await get('/api/providers/explain?surface=agent-claude', 'bld_worker');
    expect(team.status).toBe(200);
    expect(team.body.as).toBe('team');
    expect((await get('/api/providers/explain?surface=agent-claude&as=self', 'bld_worker')).status).toBe(403);
  });

  it('a task token explains its own workspace only', async () => {
    const own = await get('/api/providers/explain?surface=cloud-egress', 'bldt_task');
    expect(own.status).toBe(200);
    expect(resolve.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-1', requesterUserId: null });
    expect((await get('/api/providers/explain?surface=cloud-egress&workspaceId=ws-2', 'bldt_task')).status).toBe(404);
  });

  it('a workspace outside the team is 404', async () => {
    sessionUser = { id: 'u-1' };
    workspaceExists = false;
    expect((await get('/api/providers/explain?surface=chat&workspaceId=ws-9')).status).toBe(404);
  });

  it('never returns the resolved value', () => {
    expect(bodies.length).toBeGreaterThan(5);
    for (const b of bodies) {
      expect(b).not.toContain(SECRET);
      expect(b).not.toContain('FIXTURE');
    }
  });
});
