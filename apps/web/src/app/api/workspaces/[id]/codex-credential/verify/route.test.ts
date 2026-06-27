import { describe, it, expect, beforeEach, mock, afterAll} from 'bun:test';
import { NextRequest } from 'next/server';

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockGetCodexSecretId = mock(() => Promise.resolve(null as string | null));
const mockVerifyCodexCredential = mock(() => Promise.resolve({ verified: true, error: null }));
const mockGetCodexStatus = mock(() => Promise.resolve({
  connected: true,
  expired: false,
  accountId: 'acc-1',
  lastRefreshedAt: null,
  lastVerifiedAt: null,
  lastVerificationError: null,
  scope: 'team' as const,
}));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));
mock.module('@/lib/codex-credential', () => ({
  getCodexSecretId: mockGetCodexSecretId,
  verifyCodexCredential: mockVerifyCodexCredential,
  getCodexStatus: mockGetCodexStatus,
}));

import { POST } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

function makeReq(qs = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/workspaces/ws-1/codex-credential/verify${qs}`, { method: 'POST' });
}

describe('POST /api/workspaces/[id]/codex-credential/verify', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockGetCodexSecretId.mockReset();
    mockVerifyCodexCredential.mockReset();
    mockGetCodexStatus.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockGetCodexSecretId.mockResolvedValue('secret-1');
    mockVerifyCodexCredential.mockResolvedValue({ verified: true, error: null });
    mockGetCodexStatus.mockResolvedValue({
      connected: true, expired: false, accountId: 'acc-1', lastRefreshedAt: null,
      lastVerifiedAt: new Date().toISOString(), lastVerificationError: null, scope: 'team' as const,
    });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 404 when no credential configured', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetCodexSecretId.mockResolvedValue(null);
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No Codex credential configured');
  });

  it('returns verified:true plus persisted status when the credential is valid', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.verified).toBe(true);
    expect(data.status.lastVerifiedAt).toBeTruthy();
    expect(mockVerifyCodexCredential).toHaveBeenCalledWith('secret-1');
  });

  it('returns verified:false with the error when the credential is invalid', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyCodexCredential.mockResolvedValue({ verified: false, error: 'HTTP 401: invalid' });
    const res = await POST(makeReq(), { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.verified).toBe(false);
    expect(data.error).toBe('HTTP 401: invalid');
  });

  it('uses workspace scope when scope=workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    await POST(makeReq('?scope=workspace'), { params: mockParams });
    expect(mockGetCodexSecretId).toHaveBeenCalledWith({ teamId: 'team-1', workspaceId: 'ws-1' });
  });
});

afterAll(() => mock.restore());
