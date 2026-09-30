import { beforeEach, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
const user = mock(async () => null as any);
const account = mock(async () => null as any);
const teams = mock(async () => ['team']);
const workspaces = mock(async () => [{ id: 'ws' }]);
const metrics = mock(async () => ({ manifestCoverage: { total: 0 }, pathClaims: { calls: 0 } }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: user }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: account }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: teams }));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findMany: workspaces } } } }));
mock.module('@/lib/coordination-stats-query', () => ({ fetchCoordinationStats: metrics }));
const { GET } = await import('./route');
beforeEach(() => { user.mockResolvedValue(null); account.mockResolvedValue(null); metrics.mockClear(); });
const req = (query = '') => new NextRequest(`http://localhost/api/stats/coordination${query}`);
it('requires authentication', async () => { expect((await GET(req())).status).toBe(401); });
it('rejects inaccessible workspaces before reading metrics', async () => {
 user.mockResolvedValue({ id: 'user' });
 expect((await GET(req('?workspace=other'))).status).toBe(404);
 expect(metrics).not.toHaveBeenCalled();
});
it('validates the reporting window', async () => {
 user.mockResolvedValue({ id: 'user' });
 expect((await GET(req('?window=forever'))).status).toBe(400);
});
it('passes workspace, mission and window filters to the aggregate query', async () => {
 user.mockResolvedValue({ id: 'user' });
 const response = await GET(req('?workspace=ws&mission=11111111-1111-1111-1111-111111111111&window=24h'));
 expect(response.status).toBe(200);
 expect(metrics).toHaveBeenCalledWith({ workspaceIds: ['ws'], missionId: '11111111-1111-1111-1111-111111111111', window: '24h' });
});

it('rejects malformed mission filters before querying', async () => {
 user.mockResolvedValue({ id: 'user' });
 expect((await GET(req('?missionId=invalid'))).status).toBe(400);
 expect(metrics).not.toHaveBeenCalled();
});

it('serves authenticated worker keys and preserves team scoping', async () => {
 account.mockResolvedValue({ id: 'account', level: 'worker', teamId: 'team' });
 const request = new NextRequest('http://localhost/api/stats/coordination?workspace=ws', {
  headers: { authorization: 'Bearer bld_test' },
 });
 expect((await GET(request)).status).toBe(200);
 expect(account).toHaveBeenCalledWith('bld_test');
 expect(metrics).toHaveBeenCalledWith({ workspaceIds: ['ws'], missionId: undefined, window: '7d' });
});
