import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TOKEN = 'cf_test_token_not_real_000000000000000000';
const ACCOUNT = '0123456789abcdef0123456789abcdef';

const mockAuth = mock((_key: string | null) => Promise.resolve(null as any));
const mockUser = mock(() => Promise.resolve(null as any));
const mockTeamIds = mock((_u: string) => Promise.resolve([] as string[]));
const mockFind = mock((_teamId: string) => Promise.resolve(null as any));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuth }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockTeamIds }));
mock.module('@/lib/cloudflare-credential', () => ({
  findCloudflareSecret: mockFind,
  decodeCloudflareValue: (v: string) => JSON.parse(v),
  maskCloudflareCredential: (c: { apiToken: string; accountId: string }) => ({
    accountId: `${c.accountId.slice(0, 4)}…${c.accountId.slice(-4)}`, aiGatewayId: null, tokenHint: `…${c.apiToken.slice(-4)}`,
  }),
}));

import { GET } from './route';

const req = (q = '', auth?: string) =>
  new NextRequest(`http://localhost:3000/api/cloudflare/credential${q}`, { headers: auth ? { authorization: auth } : {} });

describe('GET /api/cloudflare/credential', () => {
  beforeEach(() => {
    mockAuth.mockReset(); mockUser.mockReset(); mockTeamIds.mockReset(); mockFind.mockReset();
    mockUser.mockResolvedValue({ id: 'u1' });
    mockTeamIds.mockResolvedValue(['team-1']);
    mockFind.mockResolvedValue({
      id: 's1', teamId: 'team-1', healthStatus: 'healthy', lastVerifiedAt: null, lastVerificationError: null,
      createdAt: new Date(0), updatedAt: new Date(0), encryptedValue: JSON.stringify({ apiToken: TOKEN, accountId: ACCOUNT }),
    });
  });

  it('401 without a session or key', async () => {
    mockUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it('returns masked metadata, never the token', async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain(ACCOUNT);
    expect(body.credential).toMatchObject({ id: 's1', accountId: '0123…cdef', tokenHint: '…0000', healthStatus: 'healthy', readable: true });
  });

  it('404 for a team the caller is not in', async () => {
    const res = await GET(req('?teamId=team-2'));
    expect(res.status).toBe(404);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('an API key sees its own team only', async () => {
    mockAuth.mockResolvedValue({ id: 'a1', teamId: 'team-9', level: 'worker' });
    await GET(req('', 'Bearer bld_x'));
    expect(mockFind).toHaveBeenCalledWith('team-9');
  });

  it('null when nothing is stored', async () => {
    mockFind.mockResolvedValue(null);
    expect(await (await GET(req())).json()).toEqual({ credential: null });
  });
});
