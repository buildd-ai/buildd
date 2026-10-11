import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

const { requirePlatformOwner } = await import('./owner-gate');
const { PLATFORM_ADMIN_ENV } = await import('@/lib/platform-admin');

const original = process.env[PLATFORM_ADMIN_ENV];
const req = (token?: string) =>
  new NextRequest('http://localhost:3000/api/admin/usage', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe('requirePlatformOwner', () => {
  beforeEach(() => {
    process.env[PLATFORM_ADMIN_ENV] = 'acct-owner';
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-owner', teamId: 't', level: 'admin' });
  });

  afterAll(() => {
    if (original === undefined) delete process.env[PLATFORM_ADMIN_ENV];
    else process.env[PLATFORM_ADMIN_ENV] = original;
  });

  it('admits an admin-level key on the platform allowlist', async () => {
    const result = await requirePlatformOwner(req('bld_x'));
    expect(result.response).toBeUndefined();
    expect(result.account?.id).toBe('acct-owner');
  });

  const refusals: Array<[string, () => void, string | undefined]> = [
    ['no credential', () => {}, undefined],
    ['a non-bld bearer (OAuth / session token)', () => {}, 'oauth_token'],
    ['an unknown key', () => mockAuthenticateApiKey.mockResolvedValue(null), 'bld_x'],
    ['a key not on the allowlist', () => mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-other', teamId: 't', level: 'admin' }), 'bld_x'],
    ['a listed account whose key is below admin', () => mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-owner', teamId: 't', level: 'worker' }), 'bld_x'],
    ['an unconfigured allowlist', () => { delete process.env[PLATFORM_ADMIN_ENV]; }, 'bld_x'],
  ];

  for (const [name, arrange, token] of refusals) {
    it(`answers 404 to ${name}, never 401/403`, async () => {
      arrange();
      const result = await requirePlatformOwner(req(token));
      expect(result.account).toBeUndefined();
      expect(result.response?.status).toBe(404);
      // The body must not hint that a gate exists.
      expect(await result.response!.json()).toEqual({ error: 'Not found' });
    });
  }
});
