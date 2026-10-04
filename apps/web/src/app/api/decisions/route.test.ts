import { beforeEach, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { canAccessTokenRoute } from '@/lib/token-route-policy';

const user = mock(async () => null as any);
const account = mock(async (..._args: any[]) => null as any);
const teams = mock(async () => ['team']);
const workspaces = mock(async () => [{ id: 'ws', teamId: 'team-1' }]);
const ledger = mock(async () => [{ id: 'd1', capability: 'task_role_shadow' }]);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: user }));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async (key: string, request: NextRequest) => {
    const token = await account(key, request);
    return token && canAccessTokenRoute(token, request) ? token : null;
  },
}));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: teams }));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findMany: workspaces } } } }));
mock.module('@buildd/core/decision-ledger', () => ({ queryDecisionLedger: ledger }));

const { GET } = await import('./route');

beforeEach(() => {
  user.mockResolvedValue(null);
  account.mockResolvedValue(null);
  ledger.mockClear();
});

const req = (query = '') => new NextRequest(`http://localhost/api/decisions${query}`);

it('requires authentication', async () => {
  expect((await GET(req('?workspaceId=ws'))).status).toBe(401);
});

it('requires a workspaceId', async () => {
  user.mockResolvedValue({ id: 'user' });
  expect((await GET(req())).status).toBe(400);
  expect(ledger).not.toHaveBeenCalled();
});

it('rejects an inaccessible workspace before reading the ledger', async () => {
  user.mockResolvedValue({ id: 'user' });
  expect((await GET(req('?workspaceId=other'))).status).toBe(404);
  expect(ledger).not.toHaveBeenCalled();
});

it('validates the reporting window', async () => {
  user.mockResolvedValue({ id: 'user' });
  expect((await GET(req('?workspaceId=ws&window=forever'))).status).toBe(400);
});

it('resolves the workspace team and passes filters through', async () => {
  user.mockResolvedValue({ id: 'user' });
  const res = await GET(req('?workspaceId=ws&capability=task_role_shadow&window=24h&disagreementOnly=true&overriddenOnly=true'));
  expect(res.status).toBe(200);
  expect(ledger).toHaveBeenCalledTimes(1);
  const [filters, limit] = ledger.mock.calls[0];
  expect(filters).toMatchObject({ teamId: 'team-1', workspaceId: 'ws', capability: 'task_role_shadow', disagreementOnly: true, overriddenOnly: true });
  expect(filters.since).toBeInstanceOf(Date);
  expect(limit).toBeUndefined();
  const body = await res.json();
  expect(body.decisions).toEqual([{ id: 'd1', capability: 'task_role_shadow' }]);
});

it('serves an authenticated worker key scoped to analytics:read', async () => {
  account.mockResolvedValue({ id: 'account', level: 'worker', scopes: ['analytics:read'], teamId: 'team' });
  const request = new NextRequest('http://localhost/api/decisions?workspaceId=ws', { headers: { authorization: 'Bearer bld_test' } });
  expect((await GET(request)).status).toBe(200);
});

it('denies a token without analytics:read', async () => {
  account.mockResolvedValue({ id: 'ci', level: 'worker', scopes: ['tasks:write'], teamId: 'team' });
  const request = new NextRequest('http://localhost/api/decisions?workspaceId=ws', { headers: { authorization: 'Bearer bld_ci' } });
  expect((await GET(request)).status).toBe(401);
  expect(ledger).not.toHaveBeenCalled();
});

it('restricts a workspace-scoped token to its own workspaces', async () => {
  account.mockResolvedValue({ id: 'reader', level: 'worker', scopes: ['analytics:read'], workspaceIds: ['ws'], teamId: 'team' });
  const other = new NextRequest('http://localhost/api/decisions?workspaceId=other', { headers: { authorization: 'Bearer bld_reader' } });
  expect((await GET(other)).status).toBe(401);
  expect(ledger).not.toHaveBeenCalled();
});

it('refuses an unfiltered request for a workspace-scoped token', async () => {
  account.mockResolvedValue({ id: 'reader', level: 'worker', scopes: ['analytics:read'], workspaceIds: ['ws'], teamId: 'team' });
  const request = new NextRequest('http://localhost/api/decisions', { headers: { authorization: 'Bearer bld_reader' } });
  expect((await GET(request)).status).toBe(401);
  expect(ledger).not.toHaveBeenCalled();
});
