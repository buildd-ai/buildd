import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
}));

import { GET } from './route';

function createMockRequest(apiKey?: string, queryParams?: Record<string, string>): NextRequest {
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const url = new URL('http://localhost:3000/api/workers/worker-1/sessions');
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, value);
    }
  }
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: new Headers(headers),
  });
}

const mockParams = Promise.resolve({ id: 'worker-1' });

describe('GET /api/workers/[id]/sessions', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkersFindFirst.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
  });

  it('returns 401 when no API key and no session', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  // API key auth tests
  describe('API key auth', () => {
    it('returns 404 when worker not found', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue(null);

      const req = createMockRequest('bld_test');
      const res = await GET(req, { params: mockParams });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Worker not found');
    });

    it('returns 403 when worker belongs to different account', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        accountId: 'account-2',
        localUiUrl: 'http://runner:3001',
        workspaceId: 'ws-1',
      });

      const req = createMockRequest('bld_test');
      const res = await GET(req, { params: mockParams });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('Forbidden');
    });

    it('returns 404 when worker has no localUiUrl', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      // First call: auth check, second call: localUiUrl lookup
      mockWorkersFindFirst
        .mockResolvedValueOnce({
          id: 'worker-1',
          accountId: 'account-1',
          localUiUrl: 'http://runner:3001',
          workspaceId: 'ws-1',
        })
        .mockResolvedValueOnce({
          id: 'worker-1',
          localUiUrl: null,
        });

      const req = createMockRequest('bld_test');
      const res = await GET(req, { params: mockParams });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain('no runner URL');
    });
  });

  // Session auth tests
  describe('session auth', () => {
    it('returns 404 when worker not found', async () => {
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockWorkersFindFirst.mockResolvedValue(null);

      const req = createMockRequest();
      const res = await GET(req, { params: mockParams });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Worker not found');
    });

    it('returns 403 when user does not have workspace access', async () => {
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'worker-1',
        workspaceId: 'ws-1',
        localUiUrl: 'http://runner:3001',
      });
      mockVerifyWorkspaceAccess.mockResolvedValue(null);

      const req = createMockRequest();
      const res = await GET(req, { params: mockParams });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('Forbidden');
    });
  });

  // Proxy tests
  describe('runner proxy', () => {
    it('returns 502 when runner is unreachable', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      // First call: auth check
      mockWorkersFindFirst
        .mockResolvedValueOnce({
          id: 'worker-1',
          accountId: 'account-1',
          localUiUrl: 'http://unreachable:9999',
          workspaceId: 'ws-1',
        })
        // Second call: localUiUrl lookup for proxying
        .mockResolvedValueOnce({
          id: 'worker-1',
          localUiUrl: 'http://unreachable:9999',
        });

      const req = createMockRequest('bld_test');
      const res = await GET(req, { params: mockParams });

      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toContain('Failed to reach runner');
    });
  });
});
