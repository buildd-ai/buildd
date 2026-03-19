import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockArtifactsFindFirst = mock(() => null as any);
const mockVerifyAccountWorkspaceAccess = mock(() => false as any);

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: { findFirst: mockArtifactsFindFirst },
    },
    update: () => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'artifact-1', shareToken: 'test-token' }]),
        })),
      })),
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  artifacts: 'artifacts',
}));

import { GET } from './route';

function createMockGetRequest(apiKey?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest('http://localhost:3000/api/artifacts/artifact-1', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

const mockParams = Promise.resolve({ artifactId: 'artifact-1' });

describe('GET /api/artifacts/[artifactId]', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockGetRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when artifact not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue(null);

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Artifact not found');
  });

  it('returns artifact when requester owns the worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      type: 'content',
      title: 'Test Artifact',
      content: 'Full content here',
      shareToken: 'share-abc',
      metadata: { key: 'value' },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      worker: { accountId: 'account-1' },
    });

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact.id).toBe('artifact-1');
    expect(data.artifact.title).toBe('Test Artifact');
    expect(data.artifact.content).toBe('Full content here');
    expect(data.artifact.type).toBe('content');
    expect(data.artifact.shareUrl).toContain('/share/share-abc');
  });

  it('returns artifact when requester has workspace access', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-2' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      type: 'report',
      title: 'Shared Report',
      content: 'Report content',
      shareToken: null,
      metadata: {},
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      worker: { accountId: 'account-1' },
    });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact.title).toBe('Shared Report');
    expect(data.artifact.shareUrl).toBeNull();
  });

  it('returns 403 when requester has no access', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-2' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      type: 'content',
      title: 'Private Artifact',
      content: 'Secret',
      shareToken: null,
      metadata: {},
      worker: { accountId: 'account-1' },
    });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
  });

  it('returns 403 when artifact has no workspace and requester is not owner', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-2' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: null,
      type: 'content',
      title: 'Orphan Artifact',
      content: 'Content',
      shareToken: null,
      metadata: {},
      worker: { accountId: 'account-1' },
    });

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
  });
});
