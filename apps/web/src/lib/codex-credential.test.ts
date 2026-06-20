import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// ── mock setup (before any imports that trigger module loading) ───────────────

const mockDbUpdate = mock(() => ({}));
const mockDbFindFirst = mock(() => Promise.resolve(null as any));
const mockDbFindMany = mock(() => Promise.resolve([] as any[]));
const mockDbDelete = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockDbInsert = mock(() => ({ values: mock(() => Promise.resolve()) }));

mock.module('@buildd/core/db', () => ({
  db: {
    update: mockDbUpdate,
    delete: mockDbDelete,
    insert: mockDbInsert,
    query: {
      secrets: { findFirst: mockDbFindFirst, findMany: mockDbFindMany },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  secrets: {
    id: 'id',
    teamId: 'team_id',
    accountId: 'account_id',
    workspaceId: 'workspace_id',
    purpose: 'purpose',
    encryptedValue: 'encrypted_value',
    tokenExpiresAt: 'token_expires_at',
    lastRefreshedAt: 'last_refreshed_at',
    lastVerifiedAt: 'last_verified_at',
    lastVerificationError: 'last_verification_error',
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

import {
  refreshCodexCredential,
  resolveCodexCredential,
  storeCodexCredential,
  getCodexStatus,
  verifyCodexCredential,
} from './codex-credential';

// helper: build an encrypted blob the way the lib does (encrypt = `enc:${json}`)
function blob(access: string, refresh: string, account: string) {
  return `enc:${JSON.stringify({ access_token: access, refresh_token: refresh, account_id: account })}`;
}

describe('storeCodexCredential', () => {
  beforeEach(() => {
    mockDbDelete.mockReset();
    mockDbInsert.mockReset();
  });

  it('replaces any existing credential at the scope, then inserts an encrypted blob', async () => {
    const deleteWhere = mock(() => Promise.resolve());
    mockDbDelete.mockReturnValue({ where: deleteWhere });
    const insertValues = mock(() => Promise.resolve());
    mockDbInsert.mockReturnValue({ values: insertValues });

    await storeCodexCredential(
      { teamId: 'team-1' },
      { access_token: 'AT', refresh_token: 'RT', account_id: 'acc-123', expires_in: 3600 },
    );

    expect(deleteWhere).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.teamId).toBe('team-1');
    expect(row.accountId).toBeNull();
    expect(row.workspaceId).toBeNull();
    expect(row.purpose).toBe('codex_credential');
    // Single encrypted JSON blob holds all three fields
    expect(row.encryptedValue).toBe(blob('AT', 'RT', 'acc-123'));
    expect(row.tokenExpiresAt).toBeInstanceOf(Date);
    expect(row.lastRefreshedAt).toBeInstanceOf(Date);
  });

  it('stores workspace scope when workspaceId is provided', async () => {
    mockDbDelete.mockReturnValue({ where: mock(() => Promise.resolve()) });
    const insertValues = mock(() => Promise.resolve());
    mockDbInsert.mockReturnValue({ values: insertValues });

    await storeCodexCredential(
      { teamId: 'team-1', workspaceId: 'ws-9' },
      { access_token: 'AT', refresh_token: 'RT', account_id: 'acc', expires_in: 3600 },
    );

    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.workspaceId).toBe('ws-9');
  });
});

describe('resolveCodexCredential', () => {
  beforeEach(() => mockDbFindMany.mockReset());

  it('returns null when no credential matches', async () => {
    mockDbFindMany.mockResolvedValue([]);
    const result = await resolveCodexCredential({ teamId: 't', accountId: 'a', workspaceId: 'w' });
    expect(result).toBeNull();
  });

  it('prefers a workspace-scoped credential over a team-wide one', async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: blob('teamAT', 'teamRT', 'team-acc'), accountId: null, workspaceId: null, tokenExpiresAt: null, lastRefreshedAt: null },
      { encryptedValue: blob('wsAT', 'wsRT', 'ws-acc'), accountId: null, workspaceId: 'w', tokenExpiresAt: null, lastRefreshedAt: null },
    ]);
    const result = await resolveCodexCredential({ teamId: 't', accountId: 'a', workspaceId: 'w' });
    expect(result?.accessToken).toBe('wsAT');
    expect(result?.accountId).toBe('ws-acc');
  });

  it('falls back to the team-wide credential when no workspace-scoped row exists', async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: blob('teamAT', 'teamRT', 'team-acc'), accountId: null, workspaceId: null, tokenExpiresAt: null, lastRefreshedAt: null },
    ]);
    const result = await resolveCodexCredential({ teamId: 't', accountId: 'a', workspaceId: 'w' });
    expect(result?.accessToken).toBe('teamAT');
  });
});

describe('getCodexStatus', () => {
  beforeEach(() => mockDbFindFirst.mockReset());

  it('reports not connected when no row exists', async () => {
    mockDbFindFirst.mockResolvedValue(null);
    const status = await getCodexStatus({ teamId: 't' });
    expect(status.connected).toBe(false);
    expect(status.scope).toBeNull();
    expect(status.lastVerifiedAt).toBeNull();
    expect(status.lastVerificationError).toBeNull();
  });

  it('surfaces account id and team scope without exposing tokens', async () => {
    mockDbFindFirst.mockResolvedValue({
      encryptedValue: blob('AT', 'RT', 'acc-xyz'),
      workspaceId: null,
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      lastRefreshedAt: new Date(),
      lastVerifiedAt: null,
      lastVerificationError: null,
    });
    const status = await getCodexStatus({ teamId: 't' });
    expect(status.connected).toBe(true);
    expect(status.expired).toBe(false);
    expect(status.accountId).toBe('acc-xyz');
    expect(status.scope).toBe('team');
    expect(status.lastVerifiedAt).toBeNull();
    expect(status.lastVerificationError).toBeNull();
  });

  it('includes lastVerifiedAt and lastVerificationError when present', async () => {
    const verifiedAt = new Date('2026-06-20T12:00:00Z');
    mockDbFindFirst.mockResolvedValue({
      encryptedValue: blob('AT', 'RT', 'acc-xyz'),
      workspaceId: null,
      tokenExpiresAt: null,
      lastRefreshedAt: null,
      lastVerifiedAt: verifiedAt,
      lastVerificationError: 'HTTP 401: Invalid token',
    });
    const status = await getCodexStatus({ teamId: 't' });
    expect(status.lastVerifiedAt).toBe(verifiedAt.toISOString());
    expect(status.lastVerificationError).toBe('HTTP 401: Invalid token');
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

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

  it('persists rotated refresh token from refresh response', async () => {
    const existingRow = { id: 's-1', encryptedValue: blob('old_access', 'old_refresh_token_A', 'acc') };

    let updateCallCount = 0;
    const secondWhere = mock(() => Promise.resolve());
    const secondSet = mock(() => ({ where: secondWhere }));

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
        json: () => Promise.resolve({ access_token: 'new_access_token', refresh_token: 'refresh_token_B', expires_in: 3600 }),
      })
    ) as any;

    const result = await refreshCodexCredential('s-1');

    expect(result).toBe('refreshed');
    expect(updateCallCount).toBe(2);

    const setArg = secondSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.encryptedValue).toBe(blob('new_access_token', 'refresh_token_B', 'acc'));
  });

  it('persists access_token and keeps old refresh token when response omits it', async () => {
    const existingRow = { id: 's-1', encryptedValue: blob('old_access', 'original_refresh', 'acc') };

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

    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'new_access_token', expires_in: 7200 }) })
    ) as any;

    await refreshCodexCredential('s-1');

    const setArg = secondSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.encryptedValue).toBe(blob('new_access_token', 'original_refresh', 'acc'));
  });

  it('sets tokenExpiresAt from expires_in field', async () => {
    const existingRow = { id: 's-1', encryptedValue: blob('old', 'old_refresh', 'acc') };

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
      Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: 'new_at', expires_in: 3600 }) })
    ) as any;

    await refreshCodexCredential('s-1');

    const setArg = secondSet.mock.calls[0]?.[0] as Record<string, unknown>;
    const expiresAt = setArg.tokenExpiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    const expectedMs = 3600 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedMs - 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(before + expectedMs + 5000);
  });

  it('returns locked when credential was refreshed within the lock window', async () => {
    const where = mock(() => ({ returning: mock(() => Promise.resolve([])) }));
    mockDbUpdate.mockReturnValue({ set: mock(() => ({ where })) });
    mockDbFindFirst.mockResolvedValue({ id: 's-1' });

    const fetchSpy = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    globalThis.fetch = fetchSpy as any;

    const result = await refreshCodexCredential('s-1');
    expect(result).toBe('locked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns no_credential when the secret does not exist', async () => {
    const where = mock(() => ({ returning: mock(() => Promise.resolve([])) }));
    mockDbUpdate.mockReturnValue({ set: mock(() => ({ where })) });
    mockDbFindFirst.mockResolvedValue(null);

    const fetchSpy = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    globalThis.fetch = fetchSpy as any;

    const result = await refreshCodexCredential('s-1');
    expect(result).toBe('no_credential');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns error and does not persist when OpenAI returns non-ok', async () => {
    const existingRow = { id: 's-1', encryptedValue: blob('old_access', 'old_refresh', 'acc') };
    const where = mock(() => ({ returning: mock(() => Promise.resolve([existingRow])) }));
    mockDbUpdate.mockReturnValue({ set: mock(() => ({ where })) });

    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'invalid_grant' }) })
    ) as any;

    const result = await refreshCodexCredential('s-1');
    expect(result).toBe('error');
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns error when fetch throws', async () => {
    const existingRow = { id: 's-1', encryptedValue: blob('old_access', 'old_refresh', 'acc') };
    const where = mock(() => ({ returning: mock(() => Promise.resolve([existingRow])) }));
    mockDbUpdate.mockReturnValue({ set: mock(() => ({ where })) });

    globalThis.fetch = mock(() => Promise.reject(new Error('Network error'))) as any;

    const result = await refreshCodexCredential('s-1');
    expect(result).toBe('error');
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not log token values', async () => {
    const existingRow = { id: 's-1', encryptedValue: blob('SECRET_ACCESS', 'SECRET_REFRESH', 'acc') };
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

    await refreshCodexCredential('s-1');

    const allLogs = [...consoleSpy.mock.calls.flat(), ...consoleSpy2.mock.calls.flat()].join(' ');
    expect(allLogs).not.toContain('SECRET_ACCESS');
    expect(allLogs).not.toContain('SECRET_REFRESH');
    expect(allLogs).not.toContain('SECRET_NEW_ACCESS');
    expect(allLogs).not.toContain('SECRET_NEW_REFRESH');

    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
  });
});

describe('verifyCodexCredential', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockDbUpdate.mockReset();
    mockDbFindFirst.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function setupUpdateMock() {
    const updateSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockDbUpdate.mockReturnValue({ set: updateSet });
    return updateSet;
  }

  it('returns verified: true when OpenAI returns 200', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blob('access_token', 'rt', 'acc') });
    const updateSet = setupUpdateMock();
    globalThis.fetch = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })) as any;

    const result = await verifyCodexCredential('s-1', { teamId: 'team-1' });

    expect(result.verified).toBe(true);
    expect(result.error).toBeNull();
    const setArg = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.lastVerificationError).toBeNull();
  });

  it('returns verified: false with HTTP error message when OpenAI returns 401', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blob('bad_token', 'rt', 'acc') });
    const updateSet = setupUpdateMock();
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: 'Invalid access token' } }),
      })
    ) as any;

    const result = await verifyCodexCredential('s-1', { teamId: 'team-1' });

    expect(result.verified).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).toContain('Invalid access token');
    const setArg = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.lastVerificationError).toBe(result.error);
  });

  it('returns verified: false with error message when fetch throws', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blob('at', 'rt', 'acc') });
    setupUpdateMock();
    globalThis.fetch = mock(() => Promise.reject(new Error('Network failure'))) as any;

    const result = await verifyCodexCredential('s-1', { teamId: 'team-1' });

    expect(result.verified).toBe(false);
    expect(result.error).toBe('Network failure');
  });

  it('returns verified: false with error when credential not found', async () => {
    mockDbFindFirst.mockResolvedValue(null);

    const result = await verifyCodexCredential('missing', { teamId: 'team-1' });

    expect(result.verified).toBe(false);
    expect(result.error).toBe('Credential not found');
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('persists lastVerifiedAt on every call (success or failure)', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blob('at', 'rt', 'acc') });
    const updateSet = setupUpdateMock();
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) })
    ) as any;

    await verifyCodexCredential('s-1', { teamId: 'team-1' });

    expect(updateSet).toHaveBeenCalledTimes(1);
    const setArg = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.lastVerifiedAt).toBeTruthy();
  });
});
