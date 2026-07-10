import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// ── mock setup (before any imports that trigger module loading) ───────────────

const mockDbUpdate = mock(() => ({}));
const mockDbFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@buildd/core/db', () => ({
  db: {
    update: mockDbUpdate,
    query: {
      secrets: { findFirst: mockDbFindFirst },
      connectors: { findFirst: mockDbFindFirst },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  secrets: {
    id: 'id',
    purpose: 'purpose',
    label: 'label',
    encryptedValue: 'encrypted_value',
    tokenExpiresAt: 'token_expires_at',
    lastRefreshedAt: 'last_refreshed_at',
    lastVerificationError: 'last_verification_error',
  },
  connectors: {
    id: 'id',
    authMode: 'auth_mode',
    discoveredMetadata: 'discovered_metadata',
    clientId: 'client_id',
    encryptedClientSecret: 'encrypted_client_secret',
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
    { NOW: { __sql_now: true } },
  ),
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { refreshMcpConnectorCredential } from './mcp-connector-refresh';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build an encrypted blob matching the mock encrypt: enc:<json> */
function blob(access: string, refresh?: string): string {
  const obj: Record<string, string> = { access_token: access };
  if (refresh !== undefined) obj.refresh_token = refresh;
  return `enc:${JSON.stringify(obj)}`;
}

/** Minimal connector row for oauth mode */
function oauthConnector(overrides: Record<string, unknown> = {}) {
  return {
    authMode: 'oauth',
    discoveredMetadata: {
      authorizationServer: { token_endpoint: 'https://as.example.com/token' },
    },
    clientId: 'client-id-1',
    encryptedClientSecret: 'enc:super-secret',
    ...overrides,
  };
}

/** Secret row returned by the lock-claim UPDATE */
function secretRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    encryptedValue: blob('old_access', 'old_refresh'),
    label: 'connector-id-1',
    ...overrides,
  };
}

/** Mock one full refresh cycle: lock-claim succeeds, findFirst returns connector */
function setupSuccessfulClaim(
  claimedRow: Record<string, unknown>,
  connectorRow: Record<string, unknown>,
) {
  let callCount = 0;
  const secondSet = mock(() => ({ where: mock(() => Promise.resolve()) }));

  mockDbUpdate.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // Lock-claim UPDATE
      const where = mock(() => ({ returning: mock(() => Promise.resolve([claimedRow])) }));
      return { set: mock(() => ({ where })) };
    }
    // Token-persist or expire UPDATE
    return { set: secondSet };
  });

  // findFirst order: first call = existence check (only when lock lost), then connector
  // For the success path, findFirst is called once for the connector.
  mockDbFindFirst.mockResolvedValue(connectorRow);

  return { secondSet };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('refreshMcpConnectorCredential', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockDbUpdate.mockReset();
    mockDbFindFirst.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── happy path ──────────────────────────────────────────────────────────────

  it('refreshes tokens and persists new access token', async () => {
    const { secondSet } = setupSuccessfulClaim(secretRow(), oauthConnector());

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: 'new_access', expires_in: 3600 }),
      }),
    ) as any;

    const result = await refreshMcpConnectorCredential('s-1');

    expect(result).toBe('refreshed');
    const setArg = secondSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.encryptedValue).toBe(blob('new_access', 'old_refresh'));
    expect(setArg.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it('persists new refresh_token when AS rotates it', async () => {
    const { secondSet } = setupSuccessfulClaim(secretRow(), oauthConnector());

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'new_access',
            refresh_token: 'rotated_refresh',
            expires_in: 7200,
          }),
      }),
    ) as any;

    const result = await refreshMcpConnectorCredential('s-1');

    expect(result).toBe('refreshed');
    const setArg = secondSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.encryptedValue).toBe(blob('new_access', 'rotated_refresh'));
  });

  it('keeps old refresh_token when AS response omits it', async () => {
    const { secondSet } = setupSuccessfulClaim(secretRow(), oauthConnector());

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: 'new_access' }),
      }),
    ) as any;

    await refreshMcpConnectorCredential('s-1');

    const setArg = secondSet.mock.calls[0]?.[0] as Record<string, unknown>;
    // refresh_token unchanged
    expect(setArg.encryptedValue).toBe(blob('new_access', 'old_refresh'));
  });

  it('uses client_secret_basic when clientSecret present', async () => {
    setupSuccessfulClaim(
      secretRow(),
      oauthConnector({ encryptedClientSecret: 'enc:my-secret' }),
    );

    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = mock((url: string, opts: RequestInit) => {
      capturedHeaders = opts.headers as Record<string, string>;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: 'new_at' }),
      });
    }) as any;

    await refreshMcpConnectorCredential('s-1');

    expect(capturedHeaders?.['Authorization']).toMatch(/^Basic /);
    // body should NOT contain client_id when using Basic auth
    const bodyString = typeof (globalThis.fetch as any).mock.calls[0]?.[1]?.body === 'string'
      ? (globalThis.fetch as any).mock.calls[0][1].body
      : '';
    expect(bodyString).not.toContain('client_id');
  });

  it('uses client_id in body when no clientSecret', async () => {
    setupSuccessfulClaim(
      secretRow(),
      oauthConnector({ encryptedClientSecret: null }),
    );

    let capturedBody: string | undefined;
    globalThis.fetch = mock((_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: 'new_at' }),
      });
    }) as any;

    await refreshMcpConnectorCredential('s-1');

    expect(capturedBody).toContain('client_id=client-id-1');
  });

  // ── invalid_grant / 4xx → expired ──────────────────────────────────────────

  it('returns expired and sets tokenExpiresAt=null on invalid_grant', async () => {
    const { secondSet } = setupSuccessfulClaim(secretRow(), oauthConnector());

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'invalid_grant' }),
      }),
    ) as any;

    const result = await refreshMcpConnectorCredential('s-1');

    expect(result).toBe('expired');
    const setArg = secondSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.tokenExpiresAt).toBeNull();
    expect(typeof setArg.lastVerificationError).toBe('string');
  });

  it('returns expired on 401 from token endpoint', async () => {
    setupSuccessfulClaim(secretRow(), oauthConnector());

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'unauthorized_client' }),
      }),
    ) as any;

    const result = await refreshMcpConnectorCredential('s-1');
    expect(result).toBe('expired');
  });

  it('returns error (not expired) on 5xx from token endpoint', async () => {
    setupSuccessfulClaim(secretRow(), oauthConnector());

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      }),
    ) as any;

    const result = await refreshMcpConnectorCredential('s-1');
    expect(result).toBe('error');
  });

  it('returns error when fetch throws', async () => {
    setupSuccessfulClaim(secretRow(), oauthConnector());
    globalThis.fetch = mock(() => Promise.reject(new Error('network down'))) as any;

    const result = await refreshMcpConnectorCredential('s-1');
    expect(result).toBe('error');
  });

  // ── optimistic lock (concurrent refresh) ───────────────────────────────────

  it('returns locked when another caller holds the lock', async () => {
    // UPDATE returns empty (another caller updated lastRefreshedAt recently)
    const where = mock(() => ({ returning: mock(() => Promise.resolve([])) }));
    mockDbUpdate.mockReturnValue({ set: mock(() => ({ where })) });
    // existence check confirms row exists
    mockDbFindFirst.mockResolvedValue({ id: 's-1' });

    const fetchSpy = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    );
    globalThis.fetch = fetchSpy as any;

    const result = await refreshMcpConnectorCredential('s-1');

    expect(result).toBe('locked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns no_credential when the secret row does not exist', async () => {
    const where = mock(() => ({ returning: mock(() => Promise.resolve([])) }));
    mockDbUpdate.mockReturnValue({ set: mock(() => ({ where })) });
    mockDbFindFirst.mockResolvedValue(null);

    const result = await refreshMcpConnectorCredential('s-1');
    expect(result).toBe('no_credential');
  });

  // ── skip header-auth connectors ─────────────────────────────────────────────

  it('returns skipped for header-auth connectors', async () => {
    setupSuccessfulClaim(secretRow(), { authMode: 'header' });

    const fetchSpy = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    );
    globalThis.fetch = fetchSpy as any;

    const result = await refreshMcpConnectorCredential('s-1');

    expect(result).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns skipped for none-auth connectors', async () => {
    setupSuccessfulClaim(secretRow(), { authMode: 'none' });

    const fetchSpy = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    );
    globalThis.fetch = fetchSpy as any;

    const result = await refreshMcpConnectorCredential('s-1');

    expect(result).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── edge cases ───────────────────────────────────────────────────────────────

  it('returns no_credential when blob has no refresh_token', async () => {
    // Blob with no refresh_token field
    setupSuccessfulClaim(
      secretRow({ encryptedValue: blob('at_only') }),
      oauthConnector(),
    );

    const fetchSpy = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    );
    globalThis.fetch = fetchSpy as any;

    const result = await refreshMcpConnectorCredential('s-1');

    expect(result).toBe('no_credential');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns error when connector has no token_endpoint in metadata', async () => {
    setupSuccessfulClaim(
      secretRow(),
      oauthConnector({ discoveredMetadata: { authorizationServer: {} } }),
    );

    const fetchSpy = mock(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    );
    globalThis.fetch = fetchSpy as any;

    const result = await refreshMcpConnectorCredential('s-1');

    expect(result).toBe('error');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
