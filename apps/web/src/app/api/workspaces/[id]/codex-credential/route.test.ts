import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mock setup (before any imports that trigger module loading) ───────────────

const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));

const mockDbInsert = mock(() => ({ values: mock(() => Promise.resolve()) }));
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
      secrets: { findFirst: mockDbFindFirst },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  secrets: {
    id: 'id', teamId: 'team_id', accountId: 'account_id', workspaceId: 'workspace_id',
    purpose: 'purpose', encryptedValue: 'encrypted_value', tokenExpiresAt: 'token_expires_at',
    lastRefreshedAt: 'last_refreshed_at',
  },
}));

mock.module('@buildd/core/secrets', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value }),
  and: (...conds: any[]) => ({ __and: conds }),
  or: (...conds: any[]) => ({ __or: conds }),
  isNull: (field: any) => ({ __isNull: field }),
  sql: Object.assign((s: any, ...v: any[]) => ({ __sql: true, s, v }), { NOW: {} }),
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { GET, POST, DELETE } from './route';

// ── helpers ───────────────────────────────────────────────────────────────────

const mockParams = Promise.resolve({ id: 'ws-1' });

// encrypted blob as the lib produces it (encrypt = `enc:${json}`)
function blob(accountId: string) {
  return `enc:${JSON.stringify({ access_token: 'at', refresh_token: 'rt', account_id: accountId })}`;
}

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
      encryptedValue: blob('acc-1'),
      workspaceId: null,
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      lastRefreshedAt: new Date(),
    });

    const res = await GET(makeReq('GET'), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connected).toBe(true);
    expect(data.expired).toBe(false);
    expect(data.accountId).toBe('acc-1');
    expect(data.scope).toBe('team');
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
    mockDbDelete.mockReset();
    mockDbFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    // GET-after-POST status check returns the stored row
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blob('acc-1'), workspaceId: null, tokenExpiresAt: null, lastRefreshedAt: new Date() });
    mockDbInsert.mockReturnValue({ values: mock(() => Promise.resolve()) });
    mockDbDelete.mockReturnValue({ where: mock(() => Promise.resolve()) });
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
    const missingFields = JSON.stringify({ access_token: 'at', account_id: 'acc' });
    const res = await POST(makeReq('POST', { authJson: missingFields }), { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('stores credential (team-wide by default) and returns updated status', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makeReq('POST', { authJson: VALID_AUTH_JSON }), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connected).toBe(true);
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
  });

  it('stores workspace-scoped credential when scope=workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const insertValues = mock(() => Promise.resolve());
    mockDbInsert.mockReturnValue({ values: insertValues });
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blob('acc-1'), workspaceId: 'ws-1', tokenExpiresAt: null, lastRefreshedAt: new Date() });

    const res = await POST(makeReq('POST', { authJson: VALID_AUTH_JSON, scope: 'workspace' }), { params: mockParams });
    expect(res.status).toBe(200);
    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.workspaceId).toBe('ws-1');
  });

  it('accepts auth.json with expiry field instead of expires_in', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const authJson = JSON.stringify({ access_token: 'at_abc', refresh_token: 'rt_xyz', account_id: 'acc-1', expiry: '2026-07-01T00:00:00Z' });
    const res = await POST(makeReq('POST', { authJson }), { params: mockParams });
    expect(res.status).toBe(200);
  });

  it('accepts the raw ~/.codex/auth.json with fields nested under tokens', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const insertValues = mock(() => Promise.resolve());
    mockDbInsert.mockReturnValue({ values: insertValues });
    const rawFile = JSON.stringify({
      OPENAI_API_KEY: null,
      auth_mode: 'chatgpt',
      tokens: { id_token: 'id', access_token: 'at_abc', refresh_token: 'rt_xyz', account_id: 'acc-1' },
      last_refresh: '2026-06-15T00:00:00Z',
    });
    const res = await POST(makeReq('POST', { authJson: rawFile }), { params: mockParams });
    expect(res.status).toBe(200);
    // Stored blob contains the unwrapped fields (encrypt mock = `enc:${json}`)
    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.encryptedValue).toBe(`enc:${JSON.stringify({ access_token: 'at_abc', refresh_token: 'rt_xyz', account_id: 'acc-1' })}`);
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
