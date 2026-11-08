import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));
const mockList = mock(async (_ws: string, _n: number) => [] as any[]);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/model-observation-store', () => ({ listModelObservations: mockList }));

import { GET } from './route';

const req = (qs: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/model-observations${qs}`, { headers });

describe('GET /api/model-observations', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockList.mockReset();
    mockList.mockResolvedValue([]);
  });

  it('requires a workspaceId', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'u' });
    expect((await GET(req(''))).status).toBe(400);
  });

  it('401 without a session or key', async () => {
    expect((await GET(req('?workspaceId=ws-1'))).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('404 for a workspace the session cannot reach, without reading rows', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'u' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    expect((await GET(req('?workspaceId=ws-other'))).status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('404 for a key whose account cannot reach the workspace', async () => {
    mockAuthenticateApiKey.mockReturnValue({ id: 'acct' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    expect((await GET(req('?workspaceId=ws-other', { authorization: 'Bearer bld_x' }))).status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('reads only the requested workspace and derives correctness from evidence, not completion', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'u' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 't' });
    mockList.mockResolvedValue([
      { workerId: 'a', terminalOutcome: 'completed', reviewVerdict: null, ciState: null, specVerdict: null, prOutcome: null, reworked: false },
      { workerId: 'b', terminalOutcome: 'completed', reviewVerdict: null, ciState: 'passed', specVerdict: null, prOutcome: null, reworked: false },
    ]);
    const res = await GET(req('?workspaceId=ws-1'));
    expect(res.status).toBe(200);
    expect(mockList.mock.calls[0][0]).toBe('ws-1');
    const body = await res.json();
    expect(body.observations.map((o: any) => o.correctness)).toEqual(['unknown', 'supported']);
  });
});

describe('spec acceptance checks', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockList.mockReset();
  });
  it('AC-6: a caller without access to a workspace never sees its rows', async () => {
    mockList.mockResolvedValue([{ workerId: 'secret-row', terminalOutcome: 'completed' }]);
    mockGetCurrentUser.mockReturnValue({ id: 'u' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    const res = await GET(req('?workspaceId=ws-other'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('secret-row');
    expect(mockList).not.toHaveBeenCalled();
  });
});
