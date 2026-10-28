import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

const mockFindMany = mock(() => Promise.resolve([] as any[]));
const mockFindFirst = mock(() => Promise.resolve(null as any));
const mockUpdate = mock(() => ({ set: () => ({ where: () => Promise.resolve() }) }));
const mockHealthOk = mock(() => Promise.resolve());
const mockHealthFail = mock(() => Promise.resolve(null));
mock.module('./credential-health', () => ({ recordCredentialAuthSuccess: mockHealthOk, recordCredentialAuthFailure: mockHealthFail }));

mock.module('@buildd/core/db', () => ({
  db: { update: mockUpdate, query: { secrets: { findMany: mockFindMany, findFirst: mockFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({
  secrets: {
    id: 'id', teamId: 'team_id', accountId: 'account_id', workspaceId: 'workspace_id', userId: 'user_id',
    purpose: 'purpose', label: 'label', encryptedValue: 'encrypted_value',
    healthStatus: 'health_status', updatedAt: 'updated_at',
  },
}));
mock.module('@buildd/core/secrets', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => {
    if (s === 'enc:throw') throw new Error('bad');
    return s.replace(/^enc:/, '');
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ __eq: { f, v } }),
  and: (...c: any[]) => ({ __and: c }),
  or: (...c: any[]) => ({ __or: c }),
  isNull: (f: any) => ({ __isNull: f }),
  inArray: (f: any, v: any[]) => ({ __inArray: { f, v } }),
  sql: Object.assign((s: any) => ({ __sql: s }), { raw: (s: string) => ({ __raw: s }) }),
}));

import { resolveAnthropicAuth, isAnthropicApiKeyAuth, verifyAnthropicApiKey } from './anthropic-auth';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'secret-1',
    purpose: 'anthropic_api_key',
    label: null,
    encryptedValue: 'enc:sk-ant-123',
    workspaceId: null,
    healthStatus: 'healthy',
    updatedAt: new Date('2026-08-01'),
    ...overrides,
  };
}

describe('resolveAnthropicAuth (API key only)', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockFindMany.mockReturnValue(Promise.resolve([]));
  });

  it('returns null when the team has no Anthropic API key', async () => {
    expect(await resolveAnthropicAuth({ teamId: 'team-1' })).toBeNull();
  });

  it('authenticates an anthropic_api_key with x-api-key', async () => {
    mockFindMany.mockReturnValue(Promise.resolve([row()]));
    const auth = await resolveAnthropicAuth({ teamId: 'team-1' });
    expect(auth!.purpose).toBe('anthropic_api_key');
    expect(auth!.headers['x-api-key']).toBe('sk-ant-123');
    expect(auth!.headers['Authorization']).toBeUndefined();
    expect(auth!.headers['anthropic-version']).toBe('2023-06-01');
    expect(isAnthropicApiKeyAuth(auth!)).toBe(true);
  });

  it('never selects a stored subscription login: the query asks for key purposes only', async () => {
    mockFindMany.mockReturnValue(Promise.resolve([
      row({ id: 's-oauth', purpose: 'oauth_token', encryptedValue: 'enc:tok-oauth' }),
      row({ id: 's-cred', purpose: 'claude_credential', encryptedValue: 'enc:{"access_token":"x"}' }),
    ]));
    expect(await resolveAnthropicAuth({ teamId: 'team-1' })).toBeNull();
    const where = (mockFindMany.mock.calls[0] as any[])[0].where;
    const purposes = JSON.stringify(where);
    expect(purposes).not.toContain('oauth_token');
    expect(purposes).not.toContain('claude_credential');
  });

  it('prefers a workspace-scoped row over the team-wide one', async () => {
    mockFindMany.mockReturnValue(Promise.resolve([
      row({ id: 's-team', encryptedValue: 'enc:key-team' }),
      row({ id: 's-ws', workspaceId: 'ws-1', encryptedValue: 'enc:key-ws' }),
    ]));
    const auth = await resolveAnthropicAuth({ teamId: 'team-1', workspaceId: 'ws-1' });
    expect(auth!.headers['x-api-key']).toBe('key-ws');
  });

  it('never lets a revoked row shadow a healthy one', async () => {
    mockFindMany.mockReturnValue(Promise.resolve([
      row({ id: 's-dead', healthStatus: 'revoked', encryptedValue: 'enc:key-dead', updatedAt: new Date('2026-08-20') }),
      row({ id: 's-live', encryptedValue: 'enc:key-live' }),
    ]));
    expect((await resolveAnthropicAuth({ teamId: 'team-1' }))!.headers['x-api-key']).toBe('key-live');
  });

  it('falls back to a revoked row only when it is the only one', async () => {
    mockFindMany.mockReturnValue(Promise.resolve([row({ healthStatus: 'revoked', encryptedValue: 'enc:key-dead' })]));
    expect((await resolveAnthropicAuth({ teamId: 'team-1' }))!.headers['x-api-key']).toBe('key-dead');
  });

  it('prefers the most recently updated row within a scope', async () => {
    mockFindMany.mockReturnValue(Promise.resolve([
      row({ id: 's-old', encryptedValue: 'enc:key-old', updatedAt: new Date('2026-01-01') }),
      row({ id: 's-new', encryptedValue: 'enc:key-new', updatedAt: new Date('2026-08-28') }),
    ]));
    expect((await resolveAnthropicAuth({ teamId: 'team-1' }))!.headers['x-api-key']).toBe('key-new');
  });

  it('returns null rather than throwing when a row cannot be decrypted', async () => {
    mockFindMany.mockReturnValue(Promise.resolve([row({ encryptedValue: 'enc:throw' })]));
    expect(await resolveAnthropicAuth({ teamId: 'team-1' })).toBeNull();
  });

  describe('canonical and legacy key storage', () => {
    const canonical = (o: Record<string, unknown> = {}) =>
      row({ id: 's-canonical', purpose: 'inference_key', label: 'anthropic', encryptedValue: 'enc:sk-ant-canonical', ...o });
    const legacy = (o: Record<string, unknown> = {}) =>
      row({ id: 's-legacy', purpose: 'anthropic_api_key', label: null, encryptedValue: 'enc:sk-ant-legacy', ...o });

    it('a team with only a legacy key resolves to it', async () => {
      mockFindMany.mockReturnValue(Promise.resolve([legacy()]));
      expect(await resolveAnthropicAuth({ teamId: 'team-1' })).toEqual({
        headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant-legacy' },
        purpose: 'anthropic_api_key',
        secretId: 's-legacy',
      });
    });

    it('a team with only a canonical key authenticates with it as an API key', async () => {
      mockFindMany.mockReturnValue(Promise.resolve([canonical()]));
      const auth = await resolveAnthropicAuth({ teamId: 'team-1' });
      expect(auth!.purpose).toBe('inference_key');
      expect(auth!.headers['x-api-key']).toBe('sk-ant-canonical');
    });

    it('canonical beats legacy in the same scope, even a newer legacy row', async () => {
      mockFindMany.mockReturnValue(Promise.resolve([
        legacy({ updatedAt: new Date('2026-08-20') }),
        canonical({ updatedAt: new Date('2026-08-01') }),
      ]));
      expect((await resolveAnthropicAuth({ teamId: 'team-1' }))!.secretId).toBe('s-canonical');
    });

    it('a workspace legacy key beats a team canonical key', async () => {
      mockFindMany.mockReturnValue(Promise.resolve([canonical(), legacy({ workspaceId: 'ws-1' })]));
      expect((await resolveAnthropicAuth({ teamId: 'team-1', workspaceId: 'ws-1' }))!.secretId).toBe('s-legacy');
    });

    it('ignores another provider’s chat key and any personal row', async () => {
      mockFindMany.mockReturnValue(Promise.resolve([
        row({ id: 's-openrouter', purpose: 'inference_key', label: 'openrouter', encryptedValue: 'enc:sk-or' }),
        canonical({ id: 's-personal', userId: 'user-1' }),
      ]));
      expect(await resolveAnthropicAuth({ teamId: 'team-1' })).toBeNull();
      const where = (mockFindMany.mock.calls[0] as any[])[0].where;
      expect(where.__and).toContainEqual({ __isNull: 'user_id' });
    });
  });
});

describe('verifyAnthropicApiKey', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    mockFindFirst.mockReset();
    mockHealthOk.mockClear();
    mockHealthFail.mockClear();
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('sends the key as x-api-key and records success', async () => {
    mockFindFirst.mockResolvedValue({ encryptedValue: 'enc:sk-ant-1', purpose: 'anthropic_api_key', label: null, userId: null });
    const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchMock as any;
    expect(await verifyAnthropicApiKey('s1')).toEqual({ verified: true, error: null });
    const [, init] = fetchMock.mock.calls[0] as any[];
    expect(init.headers['x-api-key']).toBe('sk-ant-1');
    expect(init.headers['Authorization']).toBeUndefined();
    expect(mockHealthOk).toHaveBeenCalledTimes(1);
  });

  it('records a rejected key as a failure', async () => {
    mockFindFirst.mockResolvedValue({ encryptedValue: 'enc:sk-ant-1', purpose: 'anthropic_api_key', label: null, userId: null });
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }))) as any;
    expect(await verifyAnthropicApiKey('s1')).toEqual({ verified: false, error: 'HTTP 401: invalid x-api-key' });
    expect(mockHealthFail).toHaveBeenCalledTimes(1);
  });

  it('does not verify a personal row', async () => {
    mockFindFirst.mockResolvedValue({ encryptedValue: 'enc:sk-ant-1', purpose: 'anthropic_api_key', label: null, userId: 'u1' });
    const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchMock as any;
    expect((await verifyAnthropicApiKey('s1')).verified).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
