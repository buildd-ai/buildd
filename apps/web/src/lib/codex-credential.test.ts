import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// ── mock setup (before any imports that trigger module loading) ───────────────

const mockDbUpdate = mock(() => ({}));
const mockDbFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@buildd/core/db', () => ({
  db: {
    update: mockDbUpdate,
    query: {
      codexCredentials: { findFirst: mockDbFindFirst },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  codexCredentials: {
    workspaceId: 'workspace_id',
    lastRefreshedAt: 'last_refreshed_at',
    encryptedAccessToken: 'encrypted_access_token',
    encryptedRefreshToken: 'encrypted_refresh_token',
    tokenExpiresAt: 'token_expires_at',
    id: 'id',
  },
}));

mock.module('@buildd/core/secrets', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ __eq: true, field, value }),
  and: (...conds: any[]) => ({ __and: true, conds }),
  or: (...conds: any[]) => ({ __or: true, conds }),
  isNull: (field: any) => ({ __isNull: true, field }),
  lt: (field: any, value: any) => ({ __lt: true, field, value }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ __sql: true, strings, values }),
    { NOW: { __sql_now: true } }
  ),
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { refreshCodexCredential } from './codex-credential';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeUpdateChain(returning: any[]) {
  const where = mock(() => ({ returning: mock(() => Promise.resolve(returning)) }));
  const set = mock(() => ({ where }));
  mockDbUpdate.mockReturnValue({ set });
  return { set, where };
}

function mockFetch(response: { ok: boolean; json?: () => any }) {
  return mock(() =>
    Promise.resolve({
      ok: response.ok,
      json: response.json ?? (() => Promise.resolve({})),
    })
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('refreshCodexCredential', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockDbUpdate.mockReset();
    mockDbFindFirst.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Critical: rotation persistence ──────────────────────────────────────────

  it('persists rotated refresh token from refresh response', async () => {
    // Setup: credential claimed by optimistic lock
    const existingRow = {
      workspaceId: 'ws-1',
      encryptedAccessToken: 'enc:old_access',
      encryptedRefreshToken: 'enc:old_refresh_token_A',
      tokenExpiresAt: null,
      lastRefreshedAt: null,
    };

    let updateCallCount = 0;
    const secondWhere = mock(() => Promise.resolve());
    const secondSet = mock(() => ({ where: secondWhere }));

    mockDbUpdate.mockImplementation(() => {
      updateCallCount++;
      if (updateCallCount === 1) {
        // First call: optimistic lock claim
        const where = mock(() => ({ returning: mock(() => Promise.resolve([existingRow])) }));
        return { set: mock(() => ({ where })) };
      } else {
        // Second call: persist new tokens
        return { set: secondSet };
      }
    });

    // Mock: OpenAI returns NEW refresh token (rotation)
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'new_access_token',
            refresh_token: 'refresh_token_B', // rotated!
            expires_in: 3600,
          }),
      })
    ) as any;

    const result = await refreshCodexCredential('ws-1');

    expect(result).toBe('refreshed');
    expect(updateCallCount).toBe(2);

    // Assert: second update persisted enc:refresh_token_B (NOT enc:old_refresh_token_A)
    const setArg = secondSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).toBeDefined();
    expect(setArg.encryptedRefreshToken).toBe('enc:refresh_token_B');
    expect(setArg.encryptedAccessToken).toBe('enc:new_access_token');
  });

  it('persists access_token even when response omits refresh_token', async () => {
    const existingRow = {
      workspaceId: 'ws-1',
      encryptedAccessToken: 'enc:old_access',
      encryptedRefreshToken: 'enc:original_refresh',
      tokenExpiresAt: null,
      lastRefreshedAt: null,
    };

    let updateCallCount = 0;
    const secondSet = mock(() => ({ where: mock(() => Promise.resolve()) }));

    mockDbUpdate.mockImplementation(() => {
      updateCallCount++;
      if (updateCallCount === 1) {
        const where = mock(() => ({ returning: mock(() => Promise.resolve([existingRow])) }));
        return { set: mock(() => ({ where })) };
      }
      return { set: secondSet };
    });

    // Response omits refresh_token — must fall back to keeping original
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'new_access_token',
            expires_in: 7200,
          }),
      })
    ) as any;

    await refreshCodexCredential('ws-1');

    const setArg = secondSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.encryptedAccessToken).toBe('enc:new_access_token');
    // Falls back to original refresh token (decrypted from DB)
    expect(setArg.encryptedRefreshToken).toBe('enc:original_refresh');
  });

  it('sets tokenExpiresAt from expires_in field', async () => {
    const existingRow = {
      workspaceId: 'ws-1',
      encryptedAccessToken: 'enc:old',
      encryptedRefreshToken: 'enc:old_refresh',
      tokenExpiresAt: null,
      lastRefreshedAt: null,
    };

    let updateCallCount = 0;
    const secondSet = mock(() => ({ where: mock(() => Promise.resolve()) }));

    mockDbUpdate.mockImplementation(() => {
      updateCallCount++;
      if (updateCallCount === 1) {
        const where = mock(() => ({ returning: mock(() => Promise.resolve([existingRow])) }));
        return { set: mock(() => ({ where })) };
      }
      return { set: secondSet };
    });

    const before = Date.now();
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: 'new_at', expires_in: 3600 }),
      })
    ) as any;

    await refreshCodexCredential('ws-1');

    const setArg = secondSet.mock.calls[0]?.[0] as Record<string, unknown>;
    const expiresAt = setArg.tokenExpiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    const expectedMs = 3600 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedMs - 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(before + expectedMs + 5000);
  });

  // ── Concurrent refresh lock ──────────────────────────────────────────────────

  it('returns locked when credential was refreshed within 60 minutes', async () => {
    // Optimistic lock update returns empty (another instance claimed it)
    const where = mock(() => ({ returning: mock(() => Promise.resolve([])) }));
    const set = mock(() => ({ where }));
    mockDbUpdate.mockReturnValue({ set });

    // Credential exists (was recently refreshed)
    mockDbFindFirst.mockResolvedValue({ id: 'cred-1' });

    const fetchSpy = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    globalThis.fetch = fetchSpy as any;

    const result = await refreshCodexCredential('ws-1');

    expect(result).toBe('locked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns no_credential when workspace has no codex credential', async () => {
    // Optimistic lock returns empty (no matching row)
    const where = mock(() => ({ returning: mock(() => Promise.resolve([])) }));
    const set = mock(() => ({ where }));
    mockDbUpdate.mockReturnValue({ set });

    // No credential found
    mockDbFindFirst.mockResolvedValue(null);

    const fetchSpy = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    globalThis.fetch = fetchSpy as any;

    const result = await refreshCodexCredential('ws-1');

    expect(result).toBe('no_credential');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  it('returns error when OpenAI API returns non-ok status', async () => {
    const existingRow = {
      workspaceId: 'ws-1',
      encryptedAccessToken: 'enc:old_access',
      encryptedRefreshToken: 'enc:old_refresh',
      tokenExpiresAt: null,
      lastRefreshedAt: null,
    };

    const where = mock(() => ({ returning: mock(() => Promise.resolve([existingRow])) }));
    const set = mock(() => ({ where }));
    mockDbUpdate.mockReturnValue({ set });

    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'invalid_grant' }) })
    ) as any;

    const result = await refreshCodexCredential('ws-1');

    expect(result).toBe('error');
    // Must not corrupt existing credential — only one update (the lock claim), no second persist
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns error when fetch throws (network error)', async () => {
    const existingRow = {
      workspaceId: 'ws-1',
      encryptedAccessToken: 'enc:old_access',
      encryptedRefreshToken: 'enc:old_refresh',
      tokenExpiresAt: null,
      lastRefreshedAt: null,
    };

    const where = mock(() => ({ returning: mock(() => Promise.resolve([existingRow])) }));
    const set = mock(() => ({ where }));
    mockDbUpdate.mockReturnValue({ set });

    globalThis.fetch = mock(() => Promise.reject(new Error('Network error'))) as any;

    const result = await refreshCodexCredential('ws-1');

    expect(result).toBe('error');
    // Only one update call (lock claim) — no second call to corrupt the credential
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
  });

  // ── No token logging ─────────────────────────────────────────────────────────

  it('does not log token values', async () => {
    const existingRow = {
      workspaceId: 'ws-1',
      encryptedAccessToken: 'enc:SECRET_ACCESS',
      encryptedRefreshToken: 'enc:SECRET_REFRESH',
      tokenExpiresAt: null,
      lastRefreshedAt: null,
    };

    const secondSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
    let updateCallCount = 0;
    mockDbUpdate.mockImplementation(() => {
      updateCallCount++;
      if (updateCallCount === 1) {
        const where = mock(() => ({ returning: mock(() => Promise.resolve([existingRow])) }));
        return { set: mock(() => ({ where })) };
      }
      return { set: secondSet };
    });

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: 'SECRET_NEW_ACCESS', refresh_token: 'SECRET_NEW_REFRESH', expires_in: 3600 }),
      })
    ) as any;

    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const consoleSpy2 = spyOn(console, 'error').mockImplementation(() => {});

    await refreshCodexCredential('ws-1');

    const allLogs = [
      ...consoleSpy.mock.calls.flat(),
      ...consoleSpy2.mock.calls.flat(),
    ].join(' ');

    expect(allLogs).not.toContain('SECRET_ACCESS');
    expect(allLogs).not.toContain('SECRET_REFRESH');
    expect(allLogs).not.toContain('SECRET_NEW_ACCESS');
    expect(allLogs).not.toContain('SECRET_NEW_REFRESH');

    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
  });
});
