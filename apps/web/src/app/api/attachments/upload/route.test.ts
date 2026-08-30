import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => null as any);
const mockVerifyAccountWorkspaceAccess = mock(() => false as any);
const mockGenerateSizedUploadUrl = mock(() => Promise.resolve('https://r2.example/signed'));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

mock.module('@/lib/storage', () => ({
  isStorageConfigured: () => true,
  generateSizedUploadUrl: mockGenerateSizedUploadUrl,
}));

mock.module('crypto', () => ({
  randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
}));

const { POST, MAX_ATTACHMENT_UPLOAD_BYTES } = await import('./route');

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function req(body: any, apiKey?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/attachments/upload', {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    }),
    body: JSON.stringify(body),
  });
}

function file(overrides: Record<string, unknown> = {}) {
  return { filename: 'shot.png', mimeType: 'image/png', sizeBytes: 2048, ...overrides };
}

describe('POST /api/attachments/upload', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockGenerateSizedUploadUrl.mockClear();

    mockAuthenticateApiKey.mockResolvedValue(null as any);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' } as any);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' } as any);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true as any);
  });

  it('signs a key under the requested workspace prefix', async () => {
    const res = await POST(req({ workspaceId: 'ws-1', files: [file()] }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.uploads[0].storageKey).toBe(`attachments/ws-1/${UUID}/shot.png`);
    expect(mockGenerateSizedUploadUrl).toHaveBeenCalledWith(
      `attachments/ws-1/${UUID}/shot.png`,
      'image/png',
      2048,
    );
  });

  it('does not let the supplied name change the shape of the key', async () => {
    const res = await POST(
      req({ workspaceId: 'ws-1', files: [file({ filename: '../../probe.txt' })] }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    const key = data.uploads[0].storageKey as string;
    expect(key.split('/')).toHaveLength(4);
    expect(key).not.toContain('..');
    expect(key.startsWith(`attachments/ws-1/${UUID}/`)).toBe(true);
    // The caller's name is still echoed back for display.
    expect(data.uploads[0].filename).toBe('../../probe.txt');
  });

  it('rejects a workspace the caller cannot reach', async () => {
    mockVerifyWorkspaceAccess.mockResolvedValue(null as any);
    const res = await POST(req({ workspaceId: 'ws-other', files: [file()] }));
    expect(res.status).toBe(403);
    expect(mockGenerateSizedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects a workspace an API key account cannot reach', async () => {
    mockGetCurrentUser.mockResolvedValue(null as any);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' } as any);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false as any);
    const res = await POST(req({ workspaceId: 'ws-other', files: [file()] }, 'bld_test'));
    expect(res.status).toBe(403);
    expect(mockGenerateSizedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects a workspace id that is not a usable key segment', async () => {
    const res = await POST(req({ workspaceId: '../roles', files: [file()] }));
    expect(res.status).toBe(400);
    expect(mockGenerateSizedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects a declared size above the ceiling with 413', async () => {
    const res = await POST(
      req({
        workspaceId: 'ws-1',
        files: [file({ sizeBytes: MAX_ATTACHMENT_UPLOAD_BYTES + 1 })],
      }),
    );
    expect(res.status).toBe(413);
    expect(mockGenerateSizedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects a declared size that is not a positive integer', async () => {
    for (const sizeBytes of [0, -1, 1.5, undefined, 'big']) {
      const res = await POST(req({ workspaceId: 'ws-1', files: [file({ sizeBytes })] }));
      expect(res.status).toBe(400);
    }
    expect(mockGenerateSizedUploadUrl).not.toHaveBeenCalled();
  });

  it('still enforces auth and the file count limit', async () => {
    mockGetCurrentUser.mockResolvedValue(null as any);
    expect((await POST(req({ workspaceId: 'ws-1', files: [file()] }))).status).toBe(401);

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' } as any);
    const many = Array.from({ length: 6 }, () => file());
    expect((await POST(req({ workspaceId: 'ws-1', files: many }))).status).toBe(400);
  });
});
