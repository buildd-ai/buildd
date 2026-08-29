import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(true as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));
const mockWorkspacesFindFirst = mock(() => null as any);
const mockIsBackendConfigured = mock(async (_backend: string, _scope: any) => true);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/backend-failover', () => ({ isBackendConfigured: mockIsBackendConfigured }));

mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: mockWorkspacesFindFirst } } },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value }),
}));
mock.module('@buildd/core/db/schema', () => ({ workspaces: { id: 'id' } }));

import { GET } from './route';

const params = (id: string) => Promise.resolve({ id });

describe('GET /api/workspaces/[id]/backends', () => {
  const USER = { id: 'user-1', email: 'user@example.com' };

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockIsBackendConfigured.mockReset();

    mockGetCurrentUser.mockReturnValue(USER as any);
    mockVerifyWorkspaceAccess.mockReturnValue(Promise.resolve({ teamId: 'team-1' } as any));
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', teamId: 'team-1' }),
    );
  });

  function req() {
    return new NextRequest('http://localhost/api/workspaces/ws-1/backends');
  }

  it('returns claude as always available', async () => {
    mockIsBackendConfigured.mockImplementation(async (backend) =>
      backend === 'claude' ? true : false,
    );
    const res = await GET(req(), { params: params('ws-1') });
    expect(res.status).toBe(200);
    const body = await res.json();
    const claude = body.backends.find((b: any) => b.id === 'claude');
    expect(claude).toBeDefined();
    expect(claude.available).toBe(true);
    expect(claude.reason).toBeUndefined();
  });

  it('returns codex as available when credentials are present', async () => {
    mockIsBackendConfigured.mockImplementation(async () => true);
    const res = await GET(req(), { params: params('ws-1') });
    expect(res.status).toBe(200);
    const body = await res.json();
    const codex = body.backends.find((b: any) => b.id === 'codex');
    expect(codex).toBeDefined();
    expect(codex.available).toBe(true);
    expect(codex.reason).toBeUndefined();
  });

  it('returns codex as unavailable with reason when no credentials', async () => {
    mockIsBackendConfigured.mockImplementation(async (backend) =>
      backend !== 'codex',
    );
    const res = await GET(req(), { params: params('ws-1') });
    expect(res.status).toBe(200);
    const body = await res.json();
    const codex = body.backends.find((b: any) => b.id === 'codex');
    expect(codex).toBeDefined();
    expect(codex.available).toBe(false);
    expect(codex.reason).toBeTruthy();
  });

  it('returns 401 for unauthenticated requests', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    const res = await GET(req(), { params: params('ws-1') });
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(null));
    const res = await GET(req(), { params: params('ws-1') });
    expect(res.status).toBe(404);
  });

  it('calls isBackendConfigured with correct scope', async () => {
    mockIsBackendConfigured.mockImplementation(async () => true);
    await GET(req(), { params: params('ws-1') });
    // isBackendConfigured should be called for every dispatchable backend
    expect(mockIsBackendConfigured.mock.calls.length).toBeGreaterThan(0);
    const firstCall = mockIsBackendConfigured.mock.calls[0] as [string, any];
    expect(firstCall[1]).toMatchObject({ teamId: 'team-1', workspaceId: 'ws-1' });
  });
});
