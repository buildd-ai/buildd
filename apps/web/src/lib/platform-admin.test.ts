import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

const { authorizePlatformAdmin, isPlatformAdminAccount, platformAdminAccountIds, PLATFORM_ADMIN_ENV } =
  await import('./platform-admin');

const original = process.env[PLATFORM_ADMIN_ENV];
const req = (token?: string) =>
  new NextRequest('http://localhost:3000/api/admin/x', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe('platform admin allowlist', () => {
  beforeEach(() => {
    delete process.env[PLATFORM_ADMIN_ENV];
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-op', teamId: 't', level: 'admin' });
  });

  afterAll(() => {
    if (original === undefined) delete process.env[PLATFORM_ADMIN_ENV];
    else process.env[PLATFORM_ADMIN_ENV] = original;
  });

  it('parses a comma-separated list, ignoring blanks and whitespace', () => {
    expect([...platformAdminAccountIds({ [PLATFORM_ADMIN_ENV]: ' a, b ,,c ' } as any)]).toEqual(['a', 'b', 'c']);
    expect(isPlatformAdminAccount('b', { [PLATFORM_ADMIN_ENV]: 'a,b' } as any)).toBe(true);
    expect(isPlatformAdminAccount('z', { [PLATFORM_ADMIN_ENV]: 'a,b' } as any)).toBe(false);
  });

  it('fails closed when the allowlist is unset, even for an admin-level key', async () => {
    const result = await authorizePlatformAdmin(req('bld_x'));
    expect(result.response?.status).toBe(403);
  });

  it('refuses an admin-level key that is not on the allowlist', async () => {
    process.env[PLATFORM_ADMIN_ENV] = 'acct-other';
    const result = await authorizePlatformAdmin(req('bld_x'));
    expect(result.response?.status).toBe(403);
  });

  it('admits a listed account', async () => {
    process.env[PLATFORM_ADMIN_ENV] = 'acct-other,acct-op';
    const result = await authorizePlatformAdmin(req('bld_x'));
    expect(result.response).toBeUndefined();
    expect(result.account?.id).toBe('acct-op');
  });

  it('refuses a listed account whose key is below admin level', async () => {
    process.env[PLATFORM_ADMIN_ENV] = 'acct-op';
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-op', teamId: 't', level: 'worker' });
    const result = await authorizePlatformAdmin(req('bld_x'));
    expect(result.response?.status).toBe(403);
  });

  it('does not accept OAuth bearer tokens', async () => {
    process.env[PLATFORM_ADMIN_ENV] = 'acct-op';
    const result = await authorizePlatformAdmin(req('eyJhbGciOiJIUzI1NiJ9.e30.sig'));
    expect(result.response?.status).toBe(401);
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
  });

  it('returns 401 without credentials', async () => {
    process.env[PLATFORM_ADMIN_ENV] = 'acct-op';
    const result = await authorizePlatformAdmin(req());
    expect(result.response?.status).toBe(401);
  });
});
