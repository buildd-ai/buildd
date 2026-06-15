import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mock setup (before any imports that trigger module loading) ───────────────

const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));

const mockDbInsert = mock(() => ({ values: mock(() => ({ onConflictDoUpdate: mock(() => Promise.resolve()) })) }));
const mockDbDelete = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockDbFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    insert: mockDbInsert,
    delete: mockDbDelete,
    query: {
      codexCredentials: { findFirst: mockDbFindFirst },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  codexCredentials: { workspaceId: 'workspace_id' },
}));

mock.module('@buildd/core/secrets', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value }),
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { GET, POST, DELETE } from './route';

// ── helpers ───────────────────────────────────────────────────────────────────

const mockParams = Promise.resolve({ id: 'ws-1' });

const VALID_AUTH_JSON = JSON.stringify({
  access_token: 'at_abc',
  refresh_token: 'rt_xyz',
  account_id: 'acc-1',
  expires_in: 3600,
});

function makeReq(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1/codex-credential', {
    method,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/workspaces/[id]/codex-credential', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockDbFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await GET(makeReq('GET'), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const res = await GET(makeReq('GET'), { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns status without tokens when credential exists', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockDbFindFirst.mockResolvedValue({
      accountId: 'acc-1',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await GET(makeReq('GET'), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connected).toBe(true);
    expect(data.expired).toBe(false);
    expect(data.accountId).toBe('acc-1');
    expect(data.accessToken).toBeUndefined();
    expect(data.refreshToken).toBeUndefined();
  });

  it('returns connected: false when no credential exists', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockDbFindFirst.mockResolvedValue(null);

    const res = await GET(makeReq('GET'), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connected).toBe(false);
    expect(data.accountId).toBeNull();
  });
});

describe('POST /api/workspaces/[id]/codex-credential', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockDbInsert.mockReset();
    mockDbFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    // For GET after POST (status check)
    mockDbFindFirst.mockResolvedValue({ accountId: 'acc-1', tokenExpiresAt: null });

    mockDbInsert.mockReturnValue({
      values: mock(() => ({
        onConflictDoUpdate: mock(() => Promise.resolve()),
      })),
    });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await POST(makeReq('POST', { authJson: VALID_AUTH_JSON }), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const res = await POST(makeReq('POST', { authJson: VALID_AUTH_JSON }), { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 400 when authJson is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const res = await POST(makeReq('POST', {}), { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('returns 400 when authJson is not valid JSON', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const res = await POST(makeReq('POST', { authJson: 'not-valid-json{' }), { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('returns 400 when authJson is missing required fields', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const missingFields = JSON.stringify({ access_token: 'at', account_id: 'acc' }); // no refresh_token / expiry
    const res = await POST(makeReq('POST', { authJson: missingFields }), { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('stores credential and returns updated status on valid auth.json', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const res = await POST(makeReq('POST', { authJson: VALID_AUTH_JSON }), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connected).toBe(true);
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
  });

  it('accepts auth.json with expiry field instead of expires_in', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const authJson = JSON.stringify({
      access_token: 'at_abc',
      refresh_token: 'rt_xyz',
      account_id: 'acc-1',
      expiry: '2026-07-01T00:00:00Z',
    });
    const res = await POST(makeReq('POST', { authJson }), { params: mockParams });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/workspaces/[id]/codex-credential', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockDbDelete.mockReset();
    mockDbFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });

    mockDbDelete.mockReturnValue({ where: mock(() => Promise.resolve()) });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await DELETE(makeReq('DELETE'), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const res = await DELETE(makeReq('DELETE'), { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('deletes credential and returns 204', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const res = await DELETE(makeReq('DELETE'), { params: mockParams });
    expect(res.status).toBe(204);
    expect(mockDbDelete).toHaveBeenCalledTimes(1);
  });

  it('GET after DELETE returns connected: false', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockDbFindFirst.mockResolvedValue(null);

    const res = await GET(makeReq('GET'), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connected).toBe(false);
  });
});
