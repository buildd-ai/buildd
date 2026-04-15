import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { fetchClaudeBudgetUsage } from './claude-budget';

// Mock the decryptTenantSecret function
mock.module('@buildd/core/tenant-crypto', () => ({
  decryptTenantSecret: () => 'decrypted-oauth-token',
}));

describe('fetchClaudeBudgetUsage', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  const fakeEncryptedToken = {
    encryptedValue: 'abc123',
    iv: 'def456',
    authTag: 'ghi789',
  };

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns budget usage on successful response', async () => {
    const mockUsage = {
      session: { percent: 27, resets_at: '2026-04-15T17:00:00Z' },
      weekly: { percent: 7, resets_at: '2026-04-21T00:00:00Z' },
    };

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(mockUsage), { status: 200 })
    );

    const result = await fetchClaudeBudgetUsage(fakeEncryptedToken);

    expect(result).toEqual(mockUsage);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer decrypted-oauth-token'
    );
    expect((options.headers as Record<string, string>)['anthropic-beta']).toBe(
      'oauth-2025-04-20'
    );
  });

  it('returns null on non-200 response', async () => {
    fetchSpy.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const result = await fetchClaudeBudgetUsage(fakeEncryptedToken);
    expect(result).toBeNull();
  });

  it('returns null on fetch error', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'));

    const result = await fetchClaudeBudgetUsage(fakeEncryptedToken);
    expect(result).toBeNull();
  });

  it('returns null on malformed response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 })
    );

    const result = await fetchClaudeBudgetUsage(fakeEncryptedToken);
    expect(result).toBeNull();
  });
});
