import { describe, it, expect, beforeEach, mock, afterAll} from 'bun:test';
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

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/workspaces/[id]/codex-credential/refresh', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockRefreshCodexCredential.mockReset();
    mockGetCodexSecretId.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockGetCodexSecretId.mockResolvedValue('secret-1');
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

afterAll(() => mock.restore());
