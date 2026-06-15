import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── mock setup (before any imports that trigger module loading) ───────────────

const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockRefreshCodexCredential = mock(() => Promise.resolve('refreshed' as any));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@/lib/codex-credential', () => ({
  refreshCodexCredential: mockRefreshCodexCredential,
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { POST } from './route';

// ── helpers ───────────────────────────────────────────────────────────────────

const mockParams = Promise.resolve({ id: 'ws-1' });

function makeReq(): NextRequest {
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1/codex-credential/refresh', {
    method: 'POST',
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/workspaces/[id]/codex-credential/refresh', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockRefreshCodexCredential.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
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

  it('returns { status: refreshed } when token successfully refreshed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockRefreshCodexCredential.mockResolvedValue('refreshed');

    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('refreshed');
    expect(mockRefreshCodexCredential).toHaveBeenCalledWith('ws-1');
  });

  it('returns { status: locked } when another refresh is already in progress', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockRefreshCodexCredential.mockResolvedValue('locked');

    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('locked');
  });

  it('returns { status: no_credential } when no credential is stored', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockRefreshCodexCredential.mockResolvedValue('no_credential');

    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('no_credential');
  });

  it('returns { status: error } when OpenAI API call fails', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockRefreshCodexCredential.mockResolvedValue('error');

    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('error');
  });
});

// ── refreshCodexCredential unit tests (via lib mock) ─────────────────────────
// These test the logic embedded in the function — for direct unit tests of the
// lib, see codex-credential.test.ts

describe('refreshCodexCredential integration contracts', () => {
  it('is called with the workspace id from the URL param', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockRefreshCodexCredential.mockResolvedValue('refreshed');

    const customParams = Promise.resolve({ id: 'ws-custom-999' });
    const req = new NextRequest('http://localhost:3000/api/workspaces/ws-custom-999/codex-credential/refresh', {
      method: 'POST',
    });
    await POST(req, { params: customParams });
    expect(mockRefreshCodexCredential).toHaveBeenCalledWith('ws-custom-999');
  });
});
