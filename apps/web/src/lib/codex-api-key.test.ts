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
    refreshLockedAt: 'refresh_locked_at',
    rotationStartedAt: 'rotation_started_at',
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

import { resolveCodexApiKey, verifyCodexApiKey } from './codex-api-key';

function blobWithIdToken(access: string, refresh: string, account: string, idToken = 'it_test') {
  return `enc:${JSON.stringify({ access_token: access, refresh_token: refresh, account_id: account, id_token: idToken })}`;
}
function blob(access: string, refresh: string, account: string) {
  return `enc:${JSON.stringify({ access_token: access, refresh_token: refresh, account_id: account })}`;
}
function apiKeyBlob(key: string) {
  return `enc:${JSON.stringify({ api_key: key })}`;
}

describe('resolveCodexApiKey', () => {
  beforeEach(() => mockDbFindMany.mockReset());

  it('returns null when no credential matches', async () => {
    mockDbFindMany.mockResolvedValue([]);
    expect(await resolveCodexApiKey({ teamId: 't', accountId: 'a', workspaceId: 'w' })).toBeNull();
  });

  // Model credentials spec R-2 / AC-3: a claim never carries a subscription
  // login. A stored ChatGPT/OAuth login is not an API key, so it resolves to nothing.
  it('never returns a stored OAuth login', async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: blobWithIdToken('AT', 'RT', 'acc'), accountId: null, workspaceId: 'w', tokenExpiresAt: null, healthStatus: 'healthy' },
    ]);
    expect(await resolveCodexApiKey({ teamId: 't', accountId: 'a', workspaceId: 'w' })).toBeNull();
  });

  it('returns a stored API key', async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: apiKeyBlob('sk-team'), accountId: null, workspaceId: null, tokenExpiresAt: null, healthStatus: 'healthy' },
    ]);
    expect(await resolveCodexApiKey({ teamId: 't', accountId: 'a', workspaceId: 'w' })).toEqual({ apiKey: 'sk-team' });
  });

  it('prefers a workspace-scoped API key over a team-wide one', async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: apiKeyBlob('sk-team'), accountId: null, workspaceId: null, tokenExpiresAt: null },
      { encryptedValue: apiKeyBlob('sk-ws'), accountId: null, workspaceId: 'w', tokenExpiresAt: null },
    ]);
    expect(await resolveCodexApiKey({ teamId: 't', accountId: 'a', workspaceId: 'w' })).toEqual({ apiKey: 'sk-ws' });
  });

  it('a more specific OAuth login does not hide a team-wide API key', async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: blob('wsAT', 'wsRT', 'ws-acc'), accountId: null, workspaceId: 'w', tokenExpiresAt: new Date(Date.now() + 3600_000) },
      { encryptedValue: apiKeyBlob('sk-team'), accountId: null, workspaceId: null, tokenExpiresAt: null },
    ]);
    expect(await resolveCodexApiKey({ teamId: 't', accountId: 'a', workspaceId: 'w' })).toEqual({ apiKey: 'sk-team' });
  });

  it('skips a revoked API key', async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: apiKeyBlob('sk-dead'), accountId: null, workspaceId: 'w', tokenExpiresAt: null, healthStatus: 'revoked' },
    ]);
    expect(await resolveCodexApiKey({ teamId: 't', accountId: 'a', workspaceId: 'w' })).toBeNull();
  });

  it('skips a row that does not decrypt', async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: 'enc:not-json', accountId: null, workspaceId: 'w', tokenExpiresAt: null },
      { encryptedValue: apiKeyBlob('sk-team'), accountId: null, workspaceId: null, tokenExpiresAt: null },
    ]);
    expect(await resolveCodexApiKey({ teamId: 't', accountId: 'a', workspaceId: 'w' })).toEqual({ apiKey: 'sk-team' });
  });

  it("accountId: 'any' drops the account predicate (read-only readiness reporting)", async () => {
    mockDbFindMany.mockResolvedValue([
      { encryptedValue: apiKeyBlob('sk-acct'), accountId: 'other', workspaceId: null, tokenExpiresAt: null, healthStatus: 'healthy' },
    ]);
    expect(await resolveCodexApiKey({ teamId: 't', accountId: 'any', workspaceId: 'w' })).toEqual({ apiKey: 'sk-acct' });

    const where = (mockDbFindMany.mock.calls[0][0] as any).where;
    const predicates = where.conds.filter((c: any) => c.__or);
    // Only the workspace predicate stays an OR; the account one is gone.
    expect(predicates).toHaveLength(1);
    expect(JSON.stringify(predicates[0])).toContain('workspace_id');
  });
});


describe('verifyCodexApiKey', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    mockDbFindFirst.mockReset();
    mockDbUpdate.mockReset();
    mockDbUpdate.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) } as any);
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('checks an API key against /v1/models', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: apiKeyBlob('sk-live') });
    const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchMock as any;
    expect(await verifyCodexApiKey('s1')).toEqual({ verified: true, error: null });
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init.headers.Authorization).toBe('Bearer sk-live');
  });

  it('reports a rejected key', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: apiKeyBlob('sk-bad') });
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }))) as any;
    expect(await verifyCodexApiKey('s1')).toEqual({ verified: false, error: 'HTTP 401: bad key' });
  });

  it('never calls a provider for a stored login', async () => {
    mockDbFindFirst.mockResolvedValue({ encryptedValue: blobWithIdToken('AT', 'RT', 'acc') });
    const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchMock as any;
    const res = await verifyCodexApiKey('s1');
    expect(res.verified).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
