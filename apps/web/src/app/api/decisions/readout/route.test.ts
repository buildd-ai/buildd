import { beforeEach, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { canAccessTokenRoute } from '@/lib/token-route-policy';

const user = mock(async () => null as any);
const account = mock(async (..._args: any[]) => null as any);
const teams = mock(async () => ['team']);
const workspaces = mock(async () => [{ id: 'ws', teamId: 'team-1' }]);
const readout = mock(async (kind: any, window: any) => ({ kind: typeof kind === 'string' ? kind : kind.kind, registered: typeof kind !== 'string', window, readout: { collection: { state: 'disabled' } } }));
const registered = { kind: 'buildd.registered_probe', binding: { capability: 'surface_audit_advice', mode: 'live' } };

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: user }));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async (key: string, request: NextRequest) => {
    const token = await account(key, request);
    return token && canAccessTokenRoute(token, request) ? token : null;
  },
}));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: teams }));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findMany: workspaces } } } }));
mock.module('@buildd/core/decision-readout-source', () => ({ readDecisionKindReadout: readout }));
mock.module('@buildd/core/decision-kinds', () => ({ listBuilddDecisionKinds: () => [registered] }));

const { GET } = await import('./route');

beforeEach(() => {
  user.mockResolvedValue(null);
  account.mockResolvedValue(null);
  readout.mockClear();
});

const req = (query = '') => new NextRequest(`http://localhost/api/decisions/readout${query}`);

it('requires authentication', async () => {
  expect((await GET(req('?workspaceId=ws&kind=buildd.x'))).status).toBe(401);
});

it('requires a workspaceId and a well-formed kind', async () => {
  user.mockResolvedValue({ id: 'user' });
  expect((await GET(req('?kind=buildd.x'))).status).toBe(400);
  expect((await GET(req('?workspaceId=ws'))).status).toBe(400);
  expect((await GET(req('?workspaceId=ws&kind=Not A Kind'))).status).toBe(400);
  expect(readout).not.toHaveBeenCalled();
});

it('rejects an inaccessible workspace before reading', async () => {
  user.mockResolvedValue({ id: 'user' });
  expect((await GET(req('?workspaceId=other&kind=buildd.x'))).status).toBe(404);
  expect(readout).not.toHaveBeenCalled();
});

it('validates the window', async () => {
  user.mockResolvedValue({ id: 'user' });
  expect((await GET(req('?workspaceId=ws&kind=buildd.x&window=forever'))).status).toBe(400);
});

it('reads a registered kind with its binding, scoped to the workspace team', async () => {
  user.mockResolvedValue({ id: 'user' });
  const res = await GET(req('?workspaceId=ws&kind=buildd.registered_probe&window=30d'));
  expect(res.status).toBe(200);
  const [kind, window] = readout.mock.calls[0];
  expect(kind).toBe(registered);
  expect(window).toMatchObject({ teamId: 'team-1', workspaceId: 'ws' });
  expect(window.until.getTime() - window.since.getTime()).toBe(30 * 86400000);
  expect((await res.json()).registered).toBe(true);
});

it('reads an unregistered kind id as rows only', async () => {
  user.mockResolvedValue({ id: 'user' });
  const res = await GET(req('?workspaceId=ws&kind=buildd.elsewhere'));
  expect(res.status).toBe(200);
  expect(readout.mock.calls[0][0]).toBe('buildd.elsewhere');
});

it('serves a workspace-scoped analytics:read token for its own workspace only', async () => {
  account.mockResolvedValue({ id: 'reader', level: 'worker', scopes: ['analytics:read'], workspaceIds: ['ws'], teamId: 'team' });
  const own = new NextRequest('http://localhost/api/decisions/readout?workspaceId=ws&kind=buildd.x', { headers: { authorization: 'Bearer bld_reader' } });
  expect((await GET(own)).status).toBe(200);
  const other = new NextRequest('http://localhost/api/decisions/readout?workspaceId=other&kind=buildd.x', { headers: { authorization: 'Bearer bld_reader' } });
  expect((await GET(other)).status).toBe(401);
});

it('denies a token without analytics:read', async () => {
  account.mockResolvedValue({ id: 'ci', level: 'worker', scopes: ['tasks:write'], teamId: 'team' });
  const request = new NextRequest('http://localhost/api/decisions/readout?workspaceId=ws&kind=buildd.x', { headers: { authorization: 'Bearer bld_ci' } });
  expect((await GET(request)).status).toBe(401);
});
