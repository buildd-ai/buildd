/**
 * Settings → Runners → Cloudflare → Deploy: session auth, team scoping,
 * workspace picker, step-by-step deploy. Route handler tests — no network, no
 * DB; every module the route imports is mocked.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = { id: 'u1' };

const mockUser = mock(() => Promise.resolve(null as any));
const mockTeamIds = mock((_u: string) => Promise.resolve([] as string[]));
const mockTeamRole = mock((_u: string, _t: string) => Promise.resolve('owner' as string));
const mockFindSecret = mock((_t: string) => Promise.resolve(null as any));

const mockDeployStep = mock(
  async (_step: string, _ctx: any, _deps: any) =>
    ({ ok: true, step: 'check', next: 'bucket', detail: { release: 'v0.1.0' } }) as any,
);

const mockRunAction = mock(async (..._args: any[]) => ({ status: 200, body: {} }));
const mockDeployStore = mock((..._args: any[]) => ({} as any));
const mockLoadRelease = mock(() => async () => ({ ok: true, bundle: { tag: 'v0.1.0' } }));

const mockFindFirst = mock(async (..._args: any[]) => null as any);
const mockFindMany = mock(async (..._args: any[]) => [] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockFindFirst, findMany: mockFindMany },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({ workspaces: { id: 'id', teamId: 'teamId' } }));
mock.module('@buildd/core/db/relational-sql', () => ({ sqlWhere: (...a: any[]) => a, sqlOrderBy: (...a: any[]) => a }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockTeamIds,
  getUserTeamRole: mockTeamRole,
}));
mock.module('@/lib/permissions', () => ({
  roleHas: (role: string, p: string) => role === 'owner' || role === 'admin',
}));
mock.module('@/lib/uuid', () => ({ isUuid: (v: any) => typeof v === 'string' && v.length === 36 }));
mock.module('@/lib/app-url', () => ({ appBaseUrl: () => 'https://buildd.dev' }));
mock.module('@/lib/cloudflare-credential', () => ({
  findCloudflareSecret: mockFindSecret,
}));
mock.module('@/lib/deployments/action', () => ({ runDeploymentAction: mockRunAction }));
mock.module('@/lib/deployments/store', () => ({
  credentialRefOf: () => 'cloudflare',
  deploymentStore: {},
}));
mock.module('@/lib/deployments/cloud-runner-bundle', () => ({
  releaseBundleLoader: mockLoadRelease,
}));
mock.module('@/lib/deployments/cloud-runner-store', () => ({
  cloudRunnerDeployStore: mockDeployStore,
}));
mock.module('@/lib/deployments/cloud-runner-deploy', () => ({
  CLOUD_RUNNER_SCRIPT: 'buildd-cloud-runner',
  isCloudRunnerDeployStep: (v: any) => ['check', 'bucket', 'worker', 'containers', 'connect'].includes(v),
  runCloudRunnerDeployStep: mockDeployStep,
}));

const { GET, POST } = await import('./route');

function req(method: 'GET' | 'POST', opts: { query?: string; body?: any; auth?: string } = {}) {
  const url = `http://localhost:3000/api/cloudflare/cloud-runner/deploy${opts.query ?? ''}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth) headers.authorization = opts.auth;
  return new NextRequest(url, {
    method,
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe('GET /api/cloudflare/cloud-runner/deploy', () => {
  beforeEach(() => {
    mockUser.mockReset(); mockTeamIds.mockReset(); mockTeamRole.mockReset();
    mockFindMany.mockReset();
    mockUser.mockResolvedValue(USER);
    mockTeamIds.mockResolvedValue([TEAM]);
    mockTeamRole.mockResolvedValue('owner');
    mockFindMany.mockResolvedValue([
      { id: WS, name: 'Production' },
      { id: 'ws-2', name: 'Alpha' },
    ]);
  });

  it('401 without a session', async () => {
    mockUser.mockResolvedValue(null);
    expect((await GET(req('GET', { query: `?teamId=${TEAM}` }))).status).toBe(401);
  });

  it('rejects an API key (Authorization header present)', async () => {
    const r = req('GET', { query: `?teamId=${TEAM}`, auth: 'Bearer bld_xxx' });
    expect((await GET(r)).status).toBe(401);
  });

  it('404 for a team the person is not in', async () => {
    mockTeamIds.mockResolvedValue(['other']);
    expect((await GET(req('GET', { query: `?teamId=${TEAM}` }))).status).toBe(404);
  });

  it('returns sorted workspaces for an owner', async () => {
    const res = await GET(req('GET', { query: `?teamId=${TEAM}` }));
    const body = await res.json();
    expect(body.workspaces).toEqual([
      { id: 'ws-2', name: 'Alpha' },
      { id: WS, name: 'Production' },
    ]);
  });

  it('empty workspaces for a member who may not manage', async () => {
    mockTeamRole.mockResolvedValue('member');
    const res = await GET(req('GET', { query: `?teamId=${TEAM}` }));
    expect((await res.json()).workspaces).toEqual([]);
  });
});

describe('POST /api/cloudflare/cloud-runner/deploy', () => {
  beforeEach(() => {
    mockUser.mockReset(); mockTeamIds.mockReset(); mockTeamRole.mockReset();
    mockFindFirst.mockReset(); mockFindSecret.mockReset(); mockDeployStep.mockReset();
    mockUser.mockResolvedValue(USER);
    mockTeamIds.mockResolvedValue([TEAM]);
    mockTeamRole.mockResolvedValue('owner');
    mockFindFirst.mockResolvedValue({ id: WS, teamId: TEAM, name: 'Production', webhookConfig: null });
    mockFindSecret.mockResolvedValue({ id: 's1', label: null });
    mockDeployStep.mockResolvedValue({ ok: true, step: 'check', next: 'bucket', detail: { release: 'v0.1.0' } });
  });

  it('401 without a session', async () => {
    mockUser.mockResolvedValue(null);
    expect((await POST(req('POST', { body: { step: 'check', workspaceId: WS } }))).status).toBe(401);
  });

  it('rejects an Authorization header', async () => {
    const res = await POST(req('POST', { body: { step: 'check', workspaceId: WS }, auth: 'Bearer bld_xxx' }));
    expect(res.status).toBe(401);
  });

  it('400 for an invalid step', async () => {
    const res = await POST(req('POST', { body: { step: 'bogus', workspaceId: WS } }));
    expect(res.status).toBe(400);
  });

  it('400 when workspaceId is missing', async () => {
    const res = await POST(req('POST', { body: { step: 'check' } }));
    expect(res.status).toBe(400);
  });

  it("404 for a workspace in another team's scope", async () => {
    mockTeamIds.mockResolvedValue(['other-team']);
    const res = await POST(req('POST', { body: { step: 'check', workspaceId: WS } }));
    expect(res.status).toBe(404);
  });

  it('404 when the workspace does not exist', async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await POST(req('POST', { body: { step: 'check', workspaceId: WS } }));
    expect(res.status).toBe(404);
  });

  it('403 for a member who may not manage', async () => {
    mockTeamRole.mockResolvedValue('member');
    const res = await POST(req('POST', { body: { step: 'check', workspaceId: WS } }));
    expect(res.status).toBe(403);
  });

  it('404 when no Cloudflare token is stored', async () => {
    mockFindSecret.mockResolvedValue(null);
    const res = await POST(req('POST', { body: { step: 'check', workspaceId: WS } }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('no Cloudflare token');
  });

  it('runs the deploy step and returns its result', async () => {
    const res = await POST(req('POST', { body: { step: 'check', workspaceId: WS } }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, step: 'check', next: 'bucket', detail: { release: 'v0.1.0' } });
    expect(mockDeployStep).toHaveBeenCalledTimes(1);
    const [step, ctx] = mockDeployStep.mock.calls[0];
    expect(step).toBe('check');
    expect(ctx.teamId).toBe(TEAM);
    expect(ctx.workspace.id).toBe(WS);
  });

  it('passes through a deploy step failure', async () => {
    mockDeployStep.mockResolvedValue({ ok: false, step: 'worker', status: 502, error: 'provider error' });
    const res = await POST(req('POST', { body: { step: 'worker', workspaceId: WS } }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('provider error');
  });

  it('no credential appears in the response body', async () => {
    const res = await POST(req('POST', { body: { step: 'check', workspaceId: WS } }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('bld_');
    expect(text).not.toContain('apiToken');
    expect(text).not.toContain('DISPATCH_TOKEN');
  });
});
