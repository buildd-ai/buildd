import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mock setup (before any imports that trigger module loading) ───────────────

const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockRefreshCodexCredential = mock(() => Promise.resolve('refreshed' as any));
const mockGetCodexSecretId = mock(() => Promise.resolve('secret-1' as string | null));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@/lib/codex-credential', () => ({
  refreshCodexCredential: mockRefreshCodexCredential,
  getCodexSecretId: mockGetCodexSecretId,
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { POST } from './route';

// ── helpers ───────────────────────────────────────────────────────────────────

const mockParams = Promise.resolve({ id: 'ws-1' });

function makeReq(url = 'http://localhost:3000/api/workspaces/ws-1/codex-credential/refresh'): NextRequest {
  return new NextRequest(url, { method: 'POST' });
}

function resetMocks() {
  mockGetCurrentUser.mockReset();
  mockVerifyWorkspaceAccess.mockReset();
  mockRefreshCodexCredential.mockReset();
  mockGetCodexSecretId.mockReset();
  mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
  mockGetCodexSecretId.mockResolvedValue('secret-1');
  mockRefreshCodexCredential.mockResolvedValue('refreshed');
}

// ── flag OFF (default): control-plane refresh must be rejected ────────────────
//
// docs/design/runner-oauth-broker.md: after the interactive grant, every
// token-endpoint call must originate from the runner's static egress IP. This
// route runs on the control plane, so it must not call the refresh helper
// unless the same opt-in escape hatch the crons use is set.

describe('POST /api/workspaces/[id]/codex-credential/refresh — control-plane refresh disabled (default)', () => {
  beforeEach(() => {
    resetMocks();
    delete process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH;
  });

  it('rejects with 503 and never calls the refresh helper', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.status).toBe('control_plane_refresh_disabled');
    expect(typeof data.error).toBe('string');
    expect(mockRefreshCodexCredential).not.toHaveBeenCalled();
  });

  it('explains that refresh is runner-originated', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makeReq(), { params: mockParams });
    const data = await res.json();
    expect(`${data.error} ${data.detail ?? ''}`.toLowerCase()).toContain('runner');
  });

  it('does not resolve the secret id — no DB work for a request that cannot proceed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    await POST(makeReq(), { params: mockParams });
    expect(mockGetCodexSecretId).not.toHaveBeenCalled();
  });

  it('treats any value other than "true" as off', async () => {
    process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH = '1';
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(503);
    expect(mockRefreshCodexCredential).not.toHaveBeenCalled();
  });

  it('still returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(401);
    expect(mockRefreshCodexCredential).not.toHaveBeenCalled();
  });

  it('still returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(404);
    expect(mockRefreshCodexCredential).not.toHaveBeenCalled();
  });
});

// ── flag ON: opt-in escape hatch, same as the crons ───────────────────────────

describe('POST /api/workspaces/[id]/codex-credential/refresh — BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true', () => {
  beforeEach(() => {
    resetMocks();
    process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH = 'true';
  });

  afterEach(() => {
    delete process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(401);
    expect(mockRefreshCodexCredential).not.toHaveBeenCalled();
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(404);
    expect(mockRefreshCodexCredential).not.toHaveBeenCalled();
  });

  it('returns no_credential and skips refresh when no secret at scope', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetCodexSecretId.mockResolvedValue(null);
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('no_credential');
    expect(mockRefreshCodexCredential).not.toHaveBeenCalled();
  });

  it('refreshes by resolved secret id (team scope by default)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockRefreshCodexCredential.mockResolvedValue('refreshed');
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('refreshed');
    expect(mockRefreshCodexCredential).toHaveBeenCalledWith('secret-1');
    // team-wide scope by default
    expect(mockGetCodexSecretId).toHaveBeenCalledWith({ teamId: 'team-1' });
  });

  it('uses workspace scope when scope=workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockRefreshCodexCredential.mockResolvedValue('refreshed');
    const res = await POST(makeReq('http://localhost:3000/api/workspaces/ws-1/codex-credential/refresh?scope=workspace'), { params: mockParams });
    expect(res.status).toBe(200);
    expect(mockGetCodexSecretId).toHaveBeenCalledWith({ teamId: 'team-1', workspaceId: 'ws-1' });
  });

  it('passes through locked / error outcomes', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockRefreshCodexCredential.mockResolvedValue('locked');
    const res = await POST(makeReq(), { params: mockParams });
    const data = await res.json();
    expect(data.status).toBe('locked');
  });
});
