/**
 * refreshAfterRejection: what the gateway does after a provider 401.
 *
 * The refresh lock is held for the whole lock window by whichever request
 * refreshed last, so a 401 that lands inside that window gets 'locked' back.
 * That is not a dead credential when a peer has already stored a new token:
 * the stale token is what the provider rejected, and the fresh one is retried.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

let stored: string | null = null;
const storedReads: (string | null)[] = [];
mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({
    get: async (_id: string) => {
      const v = storedReads.length ? storedReads.shift()! : stored;
      return v;
    },
  }),
}));

const mockRefresh = mock(async (_id: string) => 'locked' as string);
mock.module('./mcp-connector-refresh', () => ({ refreshMcpConnectorCredential: mockRefresh }));

mock.module('@buildd/core/db', () => ({ db: {} }));

// The assertion grant: mint (buildd signs) then exchange (the provider's token endpoint).
const mockMint = mock(async (_i: any) => ({ assertion: 'signed.jwt', expiresAt: new Date(Date.now() + 300_000) }) as any);
let exchangeSeq = 0;
const mockExchange = mock(async (_endpoint: string, _assertion: string) => ({ accessToken: `minted-${++exchangeSeq}`, expiresAt: Date.now() + 600_000 }));
mock.module('./connector-assertion', () => ({ mintConnectorAssertion: mockMint, exchangeAssertion: mockExchange }));

const { refreshAfterRejection, providerAuthHeader, markCredentialRejected, credentialStateFor, __resetAssertionTokens } = await import('./connector-gateway-store');

const blob = (access_token: string) => JSON.stringify({ access_token, refresh_token: 'rt' });
const bearer = (t: string) => ({ name: 'Authorization', value: `Bearer ${t}` });

function gateway(authMode = 'oauth', over: { workerId?: string; audience?: string | null; tokenEndpoint?: string | null } = {}) {
  return {
    run: { workerId: over.workerId ?? 'worker-1', taskId: 'task-1' } as any,
    connector: {
      id: 'conn-1', name: 'axiom', url: 'https://mcp.example/mcp', authMode, headerName: null, teamId: 'team-1', transport: 'http', discoveredMetadata: null,
      assertionAudience: over.audience === undefined ? 'https://mcp.example/mcp' : over.audience,
      assertionTokenEndpoint: over.tokenEndpoint === undefined ? 'https://mcp.example/oauth/token' : over.tokenEndpoint,
    },
    secret: authMode === 'oauth' || authMode === 'header' ? { id: 'sec-1', tokenExpiresAt: null } : null,
    caller: { accountId: 'acct-1', accountTeamId: 'team-1' },
  } as any;
}

const noWait = async () => {};

beforeEach(() => {
  stored = null;
  storedReads.length = 0;
  mockRefresh.mockReset();
  mockRefresh.mockResolvedValue('locked');
  __resetAssertionTokens();
  exchangeSeq = 0;
  mockMint.mockClear();
  mockExchange.mockClear();
});

describe('refreshAfterRejection', () => {
  it('a refresh that lands is retried', async () => {
    mockRefresh.mockResolvedValueOnce('refreshed');
    expect(await refreshAfterRejection(gateway(), bearer('old'), { wait: noWait })).toEqual({ retry: true, outcome: 'refreshed' });
  });

  it('locked, and a peer already stored a new token: retried, not reconnect_required', async () => {
    stored = blob('new');
    expect(await refreshAfterRejection(gateway(), bearer('old'), { wait: noWait })).toEqual({ retry: true, outcome: 'peer_refreshed' });
  });

  it('locked while the peer is still refreshing: waits for the new token, then retries', async () => {
    storedReads.push(blob('old'), blob('old'));
    stored = blob('new');
    const waits: number[] = [];
    const out = await refreshAfterRejection(gateway(), bearer('old'), { wait: async (ms) => { waits.push(ms); } });
    expect(out).toEqual({ retry: true, outcome: 'peer_refreshed' });
    expect(waits.length).toBe(2);
  });

  it('locked and the stored token is the one the provider rejected: no retry', async () => {
    stored = blob('old');
    expect(await refreshAfterRejection(gateway(), bearer('old'), { wait: noWait })).toEqual({ retry: false, outcome: 'locked' });
  });

  it('a refresh the provider refused is not retried', async () => {
    mockRefresh.mockResolvedValueOnce('expired');
    stored = blob('new');
    expect(await refreshAfterRejection(gateway(), bearer('old'), { wait: noWait })).toEqual({ retry: false, outcome: 'expired' });
  });

  it('a static header credential has no refresh path', async () => {
    expect(await refreshAfterRejection(gateway('header'), bearer('old'), { wait: noWait })).toEqual({ retry: false, outcome: 'skipped' });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('authMode none through the gateway', () => {
  it('sends no credential and reads no secret', async () => {
    stored = 'should-not-be-read';
    const g = gateway('none');
    expect(await providerAuthHeader(g)).toEqual({ anonymous: true });
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('a provider 401 has no refresh path, and marks nothing', async () => {
    expect(await refreshAfterRejection(gateway('none'), { anonymous: true }, { wait: noWait })).toEqual({ retry: false, outcome: 'skipped' });
    // db is an empty stub: touching it would throw.
    await markCredentialRejected(gateway('none'));
  });
});

describe('authMode assertion through the gateway: the server mints and exchanges', () => {
  it('mints as the calling worker and sends the exchanged token as a bearer', async () => {
    const auth = await providerAuthHeader(gateway('assertion'));
    expect(auth).toEqual({ name: 'Authorization', value: 'Bearer minted-1' });
    expect(mockMint.mock.calls[0][0]).toEqual({ accountId: 'acct-1', accountTeamId: 'team-1', workerId: 'worker-1', taskId: 'task-1', audience: 'https://mcp.example/mcp' });
    expect(mockExchange).toHaveBeenCalledWith('https://mcp.example/oauth/token', 'signed.jwt');
  });

  it('reuses a live token for the same worker, and mints separately for another worker', async () => {
    await providerAuthHeader(gateway('assertion'));
    expect(await providerAuthHeader(gateway('assertion'))).toEqual({ name: 'Authorization', value: 'Bearer minted-1' });
    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(await providerAuthHeader(gateway('assertion', { workerId: 'worker-2' }))).toEqual({ name: 'Authorization', value: 'Bearer minted-2' });
    expect(mockMint).toHaveBeenCalledTimes(2);
  });

  it('mints again once the cached token is near expiry', async () => {
    const now = new Date();
    await providerAuthHeader(gateway('assertion'), now);
    const later = new Date(now.getTime() + 600_000);
    expect(await providerAuthHeader(gateway('assertion'), later)).toEqual({ name: 'Authorization', value: 'Bearer minted-2' });
  });

  it('a provider 401 drops the cached token and retries with a fresh mint', async () => {
    const g = gateway('assertion');
    const first = await providerAuthHeader(g);
    expect(await refreshAfterRejection(g, first as any, { wait: noWait })).toEqual({ retry: true, outcome: 'reminted' });
    expect(await providerAuthHeader(g)).toEqual({ name: 'Authorization', value: 'Bearer minted-2' });
    await markCredentialRejected(g); // no stored credential to mark
  });

  it('no usable credential when the mint or the exchange fails, or the connector is misconfigured', async () => {
    mockMint.mockResolvedValueOnce(null as any);
    expect(await providerAuthHeader(gateway('assertion'))).toBeNull();
    mockExchange.mockRejectedValueOnce(new Error('Token exchange failed: 400'));
    expect(await providerAuthHeader(gateway('assertion'))).toBeNull();
    expect(await providerAuthHeader(gateway('assertion', { tokenEndpoint: null }))).toBeNull();
  });
});

describe('credentialStateFor', () => {
  it('none needs nothing; assertion needs its exchange config; stored modes need a healthy secret', () => {
    expect(credentialStateFor({ authMode: 'none', assertionAudience: null, assertionTokenEndpoint: null }, null)).toBe('ok');
    expect(credentialStateFor({ authMode: 'assertion', assertionAudience: 'a', assertionTokenEndpoint: 'https://t' }, null)).toBe('ok');
    expect(credentialStateFor({ authMode: 'assertion', assertionAudience: 'a', assertionTokenEndpoint: null }, null)).toBe('missing');
    expect(credentialStateFor({ authMode: 'oauth', assertionAudience: null, assertionTokenEndpoint: null }, null)).toBe('missing');
    expect(credentialStateFor({ authMode: 'header', assertionAudience: null, assertionTokenEndpoint: null }, { healthStatus: 'healthy' })).toBe('ok');
    expect(credentialStateFor({ authMode: 'oauth', assertionAudience: null, assertionTokenEndpoint: null }, { healthStatus: 'revoked' })).toBe('dead');
    // stdio auth is env-only (authMode none), but there is no remote server to proxy to.
    expect(credentialStateFor({ authMode: 'none', transport: 'stdio' }, null)).toBe('missing');
    expect(credentialStateFor({ authMode: 'none', transport: 'http' }, null)).toBe('ok');
  });
});
