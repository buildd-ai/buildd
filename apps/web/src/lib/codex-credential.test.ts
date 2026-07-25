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
    healthStatus: 'health_status',
  },
}));

mock.module('@buildd/core/secrets', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));

// Stub health side-effects so they don't interfere with codex-credential unit tests
mock.module('./credential-health', () => ({
  recordCredentialAuthSuccess: mock(() => Promise.resolve()),
  recordCredentialAuthFailure: mock(() => Promise.resolve(null)),
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
  hasCodexCredential,
  refreshCodexCredential,
  resolveCodexCredential,
  storeCodexCredential,
  getCodexStatus,
  normalizeCodexAuthJson,
  verifyCodexCredential,
} from './codex-credential';

// helper: build an encrypted blob the way the lib does (encrypt = `enc:${json}`)
function blob(access: string, refresh: string, account: string) {
  return `enc:${JSON.stringify({ access_token: access, refresh_token: refresh, account_id: account })}`;
}

// helper: blob with id_token (required by codex-cli 0.144 — must be present in auth.json)
function blobWithIdToken(access: string, refresh: string, account: string, idToken = 'it_test') {
  return `enc:${JSON.stringify({ access_token: access, refresh_token: refresh, account_id: account, id_token: idToken })}`;
}

function apiKeyBlob(key: string) {
  return `enc:${JSON.stringify({ api_key: key })}`;
}

// helper: build a fake JWT carrying an `exp` claim (signature is irrelevant — we don't verify)
function jwtWithExp(expEpoch: number): string {
  const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64url({ alg: 'none' })}.${b64url({ exp: expEpoch })}.sig`;
}

describe('normalizeCodexAuthJson', () => {
  it('accepts the raw ~/.codex/auth.json (nested under tokens) and derives expiry from the JWT', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const raw = {
      OPENAI_API_KEY: null,
      auth_mode: 'chatgpt',
      tokens: { id_token: 'x', access_token: jwtWithExp(exp), refresh_token: 'rt', account_id: 'acc-1' },
      last_refresh: '2026-06-15T00:00:00Z',
    };
    const res = normalizeCodexAuthJson(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.access_token).toBe(raw.tokens.access_token);
    expect(res.value.refresh_token).toBe('rt');
    expect(res.value.account_id).toBe('acc-1');
    expect(res.value.id_token).toBe('x'); // required by codex-cli — must be captured
    expect(res.value.expires_in).toBeGreaterThan(3500);
    expect(res.value.expires_in).toBeLessThanOrEqual(3600);
  });

  it('accepts an already-flat object with explicit expires_in', () => {
    const res = normalizeCodexAuthJson({ access_token: 'at', refresh_token: 'rt', account_id: 'acc', id_token: 'it', expires_in: 7200 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.expires_in).toBe(7200);
  });

  it('passes through an explicit expiry timestamp', () => {
    const res = normalizeCodexAuthJson({ access_token: 'at', refresh_token: 'rt', account_id: 'acc', id_token: 'it', expiry: '2026-07-01T00:00:00Z' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.expiry).toBe('2026-07-01T00:00:00Z');
  });

  it('accepts a credential with no derivable expiry (non-JWT access token)', () => {
    const res = normalizeCodexAuthJson({ tokens: { access_token: 'opaque', refresh_token: 'rt', account_id: 'acc', id_token: 'it' } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.expires_in).toBeUndefined();
    expect(res.value.expiry).toBeUndefined();
  });

  it('rejects missing required fields', () => {
    const res = normalizeCodexAuthJson({ tokens: { access_token: 'at', account_id: 'acc' } });
    expect(res.ok).toBe(false);
  });

  it('rejects an OAuth blob missing id_token (required by codex-cli 0.144)', () => {
    const res = normalizeCodexAuthJson({ access_token: 'at', refresh_token: 'rt', account_id: 'acc' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('id_token');
    }
  });

  it('rejects an OAuth blob with id_token nested under tokens but missing at all levels', () => {
    const res = normalizeCodexAuthJson({ tokens: { access_token: 'at', refresh_token: 'rt', account_id: 'acc' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('id_token');
    }
  });

  it('rejects non-objects', () => {
    expect(normalizeCodexAuthJson('nope').ok).toBe(false);
    expect(normalizeCodexAuthJson(null).ok).toBe(false);
  });
});

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

  it('includes expired credentials — Codex CLI auto-refreshes via refresh_token', async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: blob('expiredAT', 'expiredRT', 'expired-acc'), accountId: null, workspaceId: 'w', tokenExpiresAt: new Date(Date.now() - 1000), lastRefreshedAt: null },
      { encryptedValue: blob('teamAT', 'teamRT', 'team-acc'), accountId: null, workspaceId: null, tokenExpiresAt: null, lastRefreshedAt: null },
    ]);
    const result = await resolveCodexCredential({ teamId: 't', accountId: 'a', workspaceId: 'w' });
    // Workspace-scoped credential wins on specificity even when expired.
    expect(result?.accessToken).toBe('expiredAT');
  });

  it('returns expired credential when it is the only one available', async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: blob('expiredAT', 'expiredRT', 'expired-acc'), accountId: null, workspaceId: null, tokenExpiresAt: new Date(Date.now() - 1000), lastRefreshedAt: null },
    ]);
    const result = await resolveCodexCredential({ teamId: 't', accountId: 'a', workspaceId: 'w' });
    expect(result?.accessToken).toBe('expiredAT');
  });
});

describe('hasCodexCredential', () => {
  beforeEach(() => mockDbFindMany.mockReset());

  it('returns true for an unexpired credential without decrypting', async () => {
    mockDbFindMany.mockResolvedValue([{ tokenExpiresAt: new Date(Date.now() + 3600_000) }]);
    expect(await hasCodexCredential({ teamId: 't', accountId: 'a', workspaceId: 'w' })).toBe(true);
  });

  it('returns true for an expired credential — CLI can refresh the token', async () => {
    mockDbFindMany.mockResolvedValue([{ tokenExpiresAt: new Date(Date.now() - 1000) }]);
    expect(await hasCodexCredential({ teamId: 't', accountId: 'a', workspaceId: 'w' })).toBe(true);
  });
});

describe('getCodexStatus', () => {
  beforeEach(() => mockDbFindFirst.mockReset());

  it('reports not connected when no row exists', async () => {
    mockDbFindFirst.mockResolvedValue(null);
    const status = await getCodexStatus({ teamId: 't' });
    expect(status.connected).toBe(false);
    expect(status.scope).toBeNull();
  });

  it('surfaces account id and team scope without exposing tokens', async () => {
    mockDbFindFirst.mockResolvedValue({
      encryptedValue: blob('AT', 'RT', 'acc-xyz'),
      workspaceId: null,
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      lastRefreshedAt: new Date(),
    });
    const status = await getCodexStatus({ teamId: 't' });
    expect(status.connected).toBe(true);
    expect(status.expired).toBe(false);
    expect(status.accountId).toBe('acc-xyz');
    expect(status.scope).toBe('team');
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

describe('refreshCodexCredential', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.CODEX_OAUTH_CLIENT_ID = 'codex-client-test';
    mockDbUpdate.mockReset();
    mockDbFindFirst.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CODEX_OAUTH_CLIENT_ID;
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
  let setArg: Record<string, unknown> | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.CODEX_OAUTH_CLIENT_ID = 'codex-client-test';
    mockDbFindFirst.mockReset();
    mockDbUpdate.mockReset();
    setArg = undefined;
    const set = mock((arg: Record<string, unknown>) => { setArg = arg; return { where: mock(() => Promise.resolve()) }; });
    mockDbUpdate.mockImplementation(() => ({ set }));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CODEX_OAUTH_CLIENT_ID;
  });

  // ── common ─────────────────────────────────────────────────────────────────

  it('returns "Credential not found" without calling the API when no row exists', async () => {
    mockDbFindFirst.mockResolvedValue(null);
    const fetchSpy = mock(() => Promise.resolve({ ok: true })) as any;
    globalThis.fetch = fetchSpy;
    const result = await verifyCodexCredential('missing');
    expect(result).toEqual({ verified: false, error: 'Credential not found' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── API key path ────────────────────────────────────────────────────────────
  // API key credentials are verified via GET /v1/models — the only OpenAI
  // endpoint that actually accepts API key Bearer tokens.

  it('[api_key] returns verified:true and stamps lastVerifiedAt when models endpoint accepts the key', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: apiKeyBlob('sk-test'), healthStatus: 'unknown' });
    globalThis.fetch = mock(() => Promise.resolve({ ok: true })) as any;
    const result = await verifyCodexCredential('s-1');
    expect(result).toEqual({ verified: true, error: null });
    expect(setArg?.lastVerificationError).toBeNull();
    expect('lastVerifiedAt' in (setArg ?? {})).toBe(true);
  });

  it('[api_key] returns verified:false with HTTP status when models endpoint rejects', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: apiKeyBlob('sk-bad'), healthStatus: 'unknown' });
    globalThis.fetch = mock(() => Promise.resolve({
      ok: false, status: 401,
      json: () => Promise.resolve({ error: { message: 'invalid token' } }),
    })) as any;
    const result = await verifyCodexCredential('s-1');
    expect(result.verified).toBe(false);
    expect(result.error).toBe('HTTP 401: invalid token');
    expect(setArg?.lastVerificationError).toBe('HTTP 401: invalid token');
  });

  it('[api_key] returns verified:false when fetch throws', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: apiKeyBlob('sk-test'), healthStatus: 'unknown' });
    globalThis.fetch = mock(() => Promise.reject(new Error('network boom'))) as any;
    const result = await verifyCodexCredential('s-1');
    expect(result).toEqual({ verified: false, error: 'network boom' });
  });

  // ── OAuth path ──────────────────────────────────────────────────────────────
  // OAuth credentials use the refresh grant as the verification probe.
  // GET /v1/models always returns 403 for OAuth Bearer tokens — it is API-key
  // only and cannot detect validity or revocation for OAuth credentials.

  it('[oauth] uses refresh grant (not GET /v1/models) for verification', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blobWithIdToken('AT', 'RT', 'acc'), healthStatus: 'unknown' });
    const fetched: string[] = [];
    globalThis.fetch = mock((url: string) => {
      fetched.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: 'new-AT', refresh_token: 'new-RT', expires_in: 3600 }),
      });
    }) as any;
    await verifyCodexCredential('s-1');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('auth.openai.com');
    expect(fetched[0]).not.toContain('api.openai.com/v1/models');
  });

  it('[oauth] returns verified:true and writes back rotated tokens on refresh success', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blobWithIdToken('old-AT', 'old-RT', 'acc-1', 'old-IT'), healthStatus: 'unknown' });
    globalThis.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ access_token: 'new-AT', refresh_token: 'new-RT', expires_in: 3600 }),
    })) as any;
    const result = await verifyCodexCredential('s-1');
    expect(result).toEqual({ verified: true, error: null });
    // The update must include the rotated tokens, preserved id_token, and verification stamp
    expect(setArg?.encryptedValue).toBe(blobWithIdToken('new-AT', 'new-RT', 'acc-1', 'old-IT'));
    expect('lastVerifiedAt' in (setArg ?? {})).toBe(true);
    expect('lastRefreshedAt' in (setArg ?? {})).toBe(true);
    expect(setArg?.lastVerificationError).toBeNull();
    expect(setArg?.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it('[oauth] uses new id_token from refresh response when provided', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blobWithIdToken('old-AT', 'old-RT', 'acc-1', 'old-IT'), healthStatus: 'unknown' });
    globalThis.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ access_token: 'new-AT', refresh_token: 'new-RT', id_token: 'new-IT', expires_in: 3600 }),
    })) as any;
    await verifyCodexCredential('s-1');
    expect(setArg?.encryptedValue).toBe(blobWithIdToken('new-AT', 'new-RT', 'acc-1', 'new-IT'));
  });

  it('[oauth] returns verified:false when refresh grant returns 4xx (revocation)', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blobWithIdToken('AT', 'RT', 'acc'), healthStatus: 'unknown' });
    globalThis.fetch = mock(() => Promise.resolve({
      ok: false, status: 401,
      json: () => Promise.resolve({ error: 'invalid_grant', error_description: 'Token has been revoked' }),
    })) as any;
    const result = await verifyCodexCredential('s-1');
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/401/);
    expect(result.error).toMatch(/Token has been revoked/);
    expect(setArg?.lastVerificationError).toBe(result.error);
  });

  it('[oauth] returns verified:false when fetch throws', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blobWithIdToken('AT', 'RT', 'acc'), healthStatus: 'unknown' });
    globalThis.fetch = mock(() => Promise.reject(new Error('connection refused'))) as any;
    const result = await verifyCodexCredential('s-1');
    expect(result).toEqual({ verified: false, error: 'connection refused' });
  });

  it('[oauth] returns verified:false when no refresh_token is present', async () => {
    mockDbFindFirst.mockResolvedValue({
      encryptedValue: `enc:${JSON.stringify({ access_token: 'AT', account_id: 'acc', id_token: 'it' })}`,
      healthStatus: 'unknown',
    });
    const fetchSpy = mock(() => Promise.resolve({ ok: true })) as any;
    globalThis.fetch = fetchSpy;
    const result = await verifyCodexCredential('s-1');
    expect(result).toEqual({ verified: false, error: 'No refresh token available' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('[oauth] returns verified:false and marks health failure when stored blob is missing id_token', async () => {
    mockDbFindFirst.mockResolvedValue({
      encryptedValue: blob('AT', 'RT', 'acc'), // blob() does not include id_token
      healthStatus: 'unknown',
    });
    const fetchSpy = mock(() => Promise.resolve({ ok: true })) as any;
    globalThis.fetch = fetchSpy;
    const result = await verifyCodexCredential('s-1');
    expect(result.verified).toBe(false);
    expect(result.error).toContain('id_token');
    expect(fetchSpy).not.toHaveBeenCalled(); // fast-fail before hitting the API
  });

  it('[oauth] does not reset health to healthy when credential is worker-observed revoked (mirrors #1302)', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blobWithIdToken('AT', 'RT', 'acc'), healthStatus: 'revoked' });
    globalThis.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ access_token: 'new-AT', refresh_token: 'new-RT', expires_in: 3600 }),
    })) as any;
    const result = await verifyCodexCredential('s-1');
    // Tokens written back (refresh succeeded) but health preserved as revoked
    expect(result.verified).toBe(true);
    expect(result.revoked).toBe(true);
    expect(result.error).toBeNull();
  });

  it('[oauth] does not log token values', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blobWithIdToken('SECRET_AT', 'SECRET_RT', 'acc'), healthStatus: 'unknown' });
    globalThis.fetch = mock(() => Promise.resolve({
      ok: false, status: 500,
      json: () => Promise.reject(new Error('x')),
    })) as any;
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    await verifyCodexCredential('s-1');
    const logs = [...logSpy.mock.calls.flat(), ...errSpy.mock.calls.flat(), ...warnSpy.mock.calls.flat()].join(' ');
    expect(logs).not.toContain('SECRET_AT');
    expect(logs).not.toContain('SECRET_RT');
    logSpy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore();
  });
});
