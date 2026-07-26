import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyAccountWorkspaceAccess = mock(() => false as any);
const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => [] as any);
const mockArtifactsFindFirst = mock(() => null as any);

let capturedSet: any = null;
const mockArtifactsUpdate = mock(() => ({
  set: mock((vals: any) => {
    capturedSet = vals;
    return {
      where: mock(() => ({
        returning: mock(() => [{ id: 'artifact-1', ...vals }]),
      })),
    };
  }),
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: { findFirst: mockArtifactsFindFirst },
    },
    update: () => mockArtifactsUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  artifacts: 'artifacts',
}));

mock.module('crypto', () => ({
  randomBytes: () => ({ toString: () => 'fresh-token' }),
}));

import { POST, DELETE } from './route';

function createRequest(method: string, apiKey?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest('http://localhost:3000/api/artifacts/artifact-1/share', {
    method,
    headers: new Headers(headers),
  });
}

const mockParams = Promise.resolve({ artifactId: 'artifact-1' });

describe('POST /api/artifacts/[artifactId]/share', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockArtifactsUpdate.mockClear();
    capturedSet = null;
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);
    mockGetUserWorkspaceIds.mockResolvedValue([]);
  });

  it('returns 404 when artifact not found', async () => {
    mockArtifactsFindFirst.mockResolvedValue(null);

    const res = await POST(createRequest('POST', 'bld_test'), { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workspaceId: 'ws-1',
      shareToken: null,
      visibility: 'private',
      worker: { accountId: 'account-1' },
    });

    const res = await POST(createRequest('POST'), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated but no access', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-2' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workspaceId: 'ws-1',
      shareToken: null,
      visibility: 'private',
      worker: { accountId: 'account-1' },
    });

    const res = await POST(createRequest('POST', 'bld_test'), { params: mockParams });
    expect(res.status).toBe(403);
  });

  it('makes public and returns a shareUrl containing a token (API-key owner)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workspaceId: 'ws-1',
      shareToken: null,
      visibility: 'private',
      worker: { accountId: 'account-1' },
    });

    const res = await POST(createRequest('POST', 'bld_test'), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(capturedSet.visibility).toBe('public');
    expect(capturedSet.shareToken).toBe('fresh-token');
    expect(data.shareUrl).toContain('/share/fresh-token');
  });

  it('makes public via session user with workspace membership', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workspaceId: 'ws-1',
      shareToken: null,
      visibility: 'private',
      worker: null,
    });

    const res = await POST(createRequest('POST'), { params: mockParams });
    expect(res.status).toBe(200);
    expect(capturedSet.visibility).toBe('public');
  });

  it('preserves an existing token when already shared', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workspaceId: 'ws-1',
      shareToken: 'existing-token',
      visibility: 'public',
      worker: { accountId: 'account-1' },
    });

    const res = await POST(createRequest('POST', 'bld_test'), { params: mockParams });
    expect(res.status).toBe(200);
    expect(capturedSet.shareToken).toBe('existing-token');
  });
});

describe('DELETE /api/artifacts/[artifactId]/share', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockArtifactsUpdate.mockClear();
    capturedSet = null;
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);
    mockGetUserWorkspaceIds.mockResolvedValue([]);
  });

  it('returns 404 when artifact not found', async () => {
    mockArtifactsFindFirst.mockResolvedValue(null);

    const res = await DELETE(createRequest('DELETE', 'bld_test'), { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workspaceId: 'ws-1',
      shareToken: 'existing-token',
      visibility: 'public',
      worker: { accountId: 'account-1' },
    });

    const res = await DELETE(createRequest('DELETE'), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('makes private and nulls the token (API-key owner)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workspaceId: 'ws-1',
      shareToken: 'existing-token',
      visibility: 'public',
      worker: { accountId: 'account-1' },
    });

    const res = await DELETE(createRequest('DELETE', 'bld_test'), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(capturedSet.visibility).toBe('private');
    expect(capturedSet.shareToken).toBeNull();
  });
});
