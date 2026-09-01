import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));
const mockListMountedConnectors = mock(() => Promise.resolve({ ok: true, connectors: [] } as any));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

mock.module('@/lib/connector-queries', () => ({
  listMountedConnectors: mockListMountedConnectors,
}));

import { GET } from './route';

function makeRequest(workspaceId: string | null = WORKSPACE_ID, bearer = 'bld_test') {
  const url = workspaceId
    ? `http://localhost/api/connectors/mounted?workspaceId=${workspaceId}`
    : 'http://localhost/api/connectors/mounted';
  return new NextRequest(url, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

describe('GET /api/connectors/mounted', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockListMountedConnectors.mockReset();

    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'worker', teamId: 'team-1' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockListMountedConnectors.mockResolvedValue({ ok: true, connectors: [] });
  });

  it('rejects unauthenticated requests', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('requires workspaceId', async () => {
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(400);
  });

  it('is reachable by a non-admin worker-level API key (unlike /api/workspaces/[id]/connectors)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', level: 'worker', teamId: 'team-1' });
    mockListMountedConnectors.mockResolvedValue({
      ok: true,
      connectors: [{ id: 'c1', name: 'GitHub', authMode: 'oauth', status: 'ok' }],
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connectors).toEqual([{ id: 'c1', name: 'GitHub', authMode: 'oauth', status: 'ok' }]);
  });

  it('404s when the API-key account has no access to the workspace', async () => {
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
    expect(mockListMountedConnectors).not.toHaveBeenCalled();
  });

  it('authenticates a session user via verifyWorkspaceAccess', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-1', WORKSPACE_ID);
  });

  it('404s when the workspace does not exist', async () => {
    mockListMountedConnectors.mockResolvedValue({ ok: false, error: 'workspace_not_found' });
    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('workspace_not_found');
  });
});
