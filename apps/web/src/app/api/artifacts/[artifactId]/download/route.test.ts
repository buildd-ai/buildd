/**
 * Regression tests for artifact download authorization.
 *
 * The tokenless branch used to accept ANY authenticated caller: it resolved an
 * API-key account or a session user, checked only that one of them existed, and
 * then signed a download URL for the artifact — which was fetched by id alone,
 * with no worker/workspace relation loaded, so no tenant comparison was even
 * possible. Any valid API key could read any artifact's bytes by id.
 *
 * Run: bun run scripts/run-unit-tests.ts "apps/web/src/app/api/artifacts/[artifactId]/download/route.test.ts"
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockGetCurrentUser = mock(() => null as any);
const mockArtifactsFindFirst = mock(() => null as any);
const mockVerifyAccountWorkspaceAccess = mock(() => false as any);
const mockVerifyWorkspaceAccess = mock(() => null as any);
const mockGenerateDownloadUrl = mock(() => Promise.resolve('https://r2.example/signed-object'));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@/lib/storage', () => ({
  isStorageConfigured: () => true,
  generateDownloadUrl: mockGenerateDownloadUrl,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: { findFirst: mockArtifactsFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  artifacts: 'artifacts',
}));

const { GET } = await import('./route');

const mockParams = Promise.resolve({ artifactId: 'artifact-1' });

function req(opts: { apiKey?: string; token?: string } = {}): NextRequest {
  const url = opts.token
    ? `http://localhost:3000/api/artifacts/artifact-1/download?token=${opts.token}`
    : 'http://localhost:3000/api/artifacts/artifact-1/download';
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers['authorization'] = `Bearer ${opts.apiKey}`;
  return new NextRequest(url, { method: 'GET', headers: new Headers(headers) });
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'artifact-1',
    workerId: 'worker-1',
    workspaceId: 'ws-1',
    storageKey: 'artifacts/ws-1/uuid/report.pdf',
    shareToken: null,
    visibility: 'private',
    metadata: { filename: 'report.pdf' },
    worker: { accountId: 'account-owner' },
    ...overrides,
  };
}

describe('GET /api/artifacts/[artifactId]/download', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetCurrentUser.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockGenerateDownloadUrl.mockClear();

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
  });

  // A published artifact is readable without a credential: agents embed this URL
  // in artifact prose (`upload_artifact` calls it "permanent, for markdown
  // embedding"), and the share page serves that prose anonymously. Requiring a
  // credential broke every embedded image on a shared page.
  it('serves a published artifact with no token and no caller', async () => {
    mockArtifactsFindFirst.mockResolvedValue(artifact({ visibility: 'public' }));

    const res = await GET(req(), { params: mockParams });

    expect(res.status).toBe(307);
    expect(mockGenerateDownloadUrl).toHaveBeenCalledWith('artifacts/ws-1/uuid/report.pdf');
    // No scope resolution is attempted — publishing already opened the bytes.
    expect(mockVerifyAccountWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockVerifyWorkspaceAccess).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no token and no caller', async () => {
    mockArtifactsFindFirst.mockResolvedValue(artifact());
    const res = await GET(req(), { params: mockParams });
    expect(res.status).toBe(401);
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects a tokenless API-key caller from another tenant and signs nothing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-other' });
    // Not the worker owner, and not a member of the artifact's workspace.
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    mockArtifactsFindFirst.mockResolvedValue(artifact());

    const res = await GET(req({ apiKey: 'bld_other' }), { params: mockParams });

    expect(res.status).toBe(403);
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects a tokenless session caller who is not a workspace member', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-other' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    mockArtifactsFindFirst.mockResolvedValue(artifact());

    const res = await GET(req(), { params: mockParams });

    expect(res.status).toBe(403);
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects when the artifact has no workspace and the caller does not own the worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-other' });
    mockArtifactsFindFirst.mockResolvedValue(artifact({ workspaceId: null }));

    const res = await GET(req({ apiKey: 'bld_other' }), { params: mockParams });

    expect(res.status).toBe(403);
    expect(mockVerifyAccountWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
  });

  it('allows the account that owns the artifact worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-owner' });
    mockArtifactsFindFirst.mockResolvedValue(artifact());

    const res = await GET(req({ apiKey: 'bld_owner' }), { params: mockParams });

    expect(res.status).toBe(307);
    expect(mockGenerateDownloadUrl).toHaveBeenCalledWith('artifacts/ws-1/uuid/report.pdf');
  });

  it('allows an API-key caller with access to the artifact workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-member' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockArtifactsFindFirst.mockResolvedValue(artifact());

    const res = await GET(req({ apiKey: 'bld_member' }), { params: mockParams });

    expect(res.status).toBe(307);
    expect(mockVerifyAccountWorkspaceAccess).toHaveBeenCalledWith('account-member', 'ws-1');
    expect(mockGenerateDownloadUrl).toHaveBeenCalled();
  });

  it('allows a session user who is a member of the artifact workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-member' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockArtifactsFindFirst.mockResolvedValue(artifact());

    const res = await GET(req(), { params: mockParams });

    expect(res.status).toBe(307);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-member', 'ws-1');
    expect(mockGenerateDownloadUrl).toHaveBeenCalled();
  });

  it('still serves a valid token for a public artifact without any caller scope', async () => {
    mockArtifactsFindFirst.mockResolvedValue(
      artifact({ shareToken: 'good-token', visibility: 'public' })
    );

    const res = await GET(req({ token: 'good-token' }), { params: mockParams });

    expect(res.status).toBe(307);
    expect(mockGenerateDownloadUrl).toHaveBeenCalled();
    // The token path must not fall through to caller resolution.
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
  });

  // Contract change: once an artifact is published, the token stops being what
  // grants access — `visibility: 'public'` does. A wrong token on a published
  // artifact is therefore served, not rejected: the bytes are already public to
  // anyone with the id. A wrong token on a PRIVATE artifact is still rejected,
  // which is the case that carries a security meaning (below).
  it('serves a published artifact even when the token is wrong', async () => {
    mockArtifactsFindFirst.mockResolvedValue(
      artifact({ shareToken: 'good-token', visibility: 'public' })
    );

    const res = await GET(req({ token: 'wrong-token' }), { params: mockParams });

    expect(res.status).toBe(307);
  });

  it('rejects a bad token on a private artifact', async () => {
    mockArtifactsFindFirst.mockResolvedValue(
      artifact({ shareToken: 'good-token', visibility: 'private' })
    );

    const res = await GET(req({ token: 'wrong-token' }), { params: mockParams });

    expect(res.status).toBe(403);
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
  });

  it('still rejects a valid token once the artifact is private again', async () => {
    mockArtifactsFindFirst.mockResolvedValue(
      artifact({ shareToken: 'good-token', visibility: 'private' })
    );

    const res = await GET(req({ token: 'good-token' }), { params: mockParams });

    expect(res.status).toBe(403);
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
  });
});
