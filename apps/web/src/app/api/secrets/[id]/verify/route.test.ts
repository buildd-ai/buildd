import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockSecretsFindFirst = mock(() => null as any);
const mockVerifyClaudeCredential = mock(() => Promise.resolve({ ok: true }) as any);
const mockVerifyCodexCredential = mock(() => Promise.resolve({ ok: true }) as any);
const mockVerifyCloudflareCredential = mock(() => Promise.resolve({ verified: true, error: null }) as any);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));
mock.module('@/lib/claude-credential', () => ({ verifyClaudeCredential: mockVerifyClaudeCredential }));
mock.module('@/lib/codex-credential', () => ({
  getCodexSecretId: mock(() => Promise.resolve(null)),
  verifyCodexCredential: mockVerifyCodexCredential,
}));
mock.module('@/lib/cloudflare-credential', () => ({ verifyCloudflareCredential: mockVerifyCloudflareCredential }));
mock.module('@buildd/core/db', () => ({
  db: { query: { secrets: { findFirst: mockSecretsFindFirst } } },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  secrets: { id: 'id', teamId: 'teamId', purpose: 'purpose' },
}));

import { POST } from './route';

const SECRET_ID = '11111111-1111-4111-8111-111111111111';
const req = (id: string) =>
  new NextRequest(`http://localhost:3000/api/secrets/${id}/verify`, { method: 'POST' });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/secrets/[id]/verify', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockSecretsFindFirst.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
  });

  it('returns 404 for a non-UUID id without authenticating or querying the db', async () => {
    const res = await POST(req('not-a-uuid'), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockSecretsFindFirst).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(req(SECRET_ID), ctx(SECRET_ID));
    expect(res.status).toBe(401);
  });

  it('returns 404 when the credential is not found', async () => {
    mockSecretsFindFirst.mockResolvedValue(null);
    const res = await POST(req(SECRET_ID), ctx(SECRET_ID));
    expect(res.status).toBe(404);
  });

  it('verifies an oauth_token credential', async () => {
    mockSecretsFindFirst.mockResolvedValue({ id: SECRET_ID, teamId: 'team-1', purpose: 'oauth_token' });
    const res = await POST(req(SECRET_ID), ctx(SECRET_ID));
    expect(res.status).toBe(200);
    expect(mockVerifyClaudeCredential).toHaveBeenCalledWith(SECRET_ID);
  });

  it('verifies a cloudflare_token credential', async () => {
    mockSecretsFindFirst.mockResolvedValue({ id: SECRET_ID, teamId: 'team-1', purpose: 'cloudflare_token' });
    const res = await POST(req(SECRET_ID), ctx(SECRET_ID));
    expect(res.status).toBe(200);
    expect(mockVerifyCloudflareCredential).toHaveBeenCalledWith(SECRET_ID);
    expect(await res.json()).toEqual({ verified: true, error: null });
  });

  it('refuses to verify another team\'s cloudflare_token', async () => {
    mockVerifyCloudflareCredential.mockClear();
    mockSecretsFindFirst.mockResolvedValue({ id: SECRET_ID, teamId: 'team-2', purpose: 'cloudflare_token' });
    const res = await POST(req(SECRET_ID), ctx(SECRET_ID));
    expect(res.status).toBe(403);
    expect(mockVerifyCloudflareCredential).not.toHaveBeenCalled();
  });
});
