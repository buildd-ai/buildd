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

const { refreshAfterRejection } = await import('./connector-gateway-store');

const blob = (access_token: string) => JSON.stringify({ access_token, refresh_token: 'rt' });
const bearer = (t: string) => ({ name: 'Authorization', value: `Bearer ${t}` });

function gateway(authMode = 'oauth') {
  return {
    run: {} as any,
    connector: { id: 'conn-1', name: 'axiom', url: 'https://mcp.example/mcp', authMode, headerName: null, teamId: 'team-1', transport: 'http', discoveredMetadata: null },
    secret: { id: 'sec-1', tokenExpiresAt: null },
  } as any;
}

const noWait = async () => {};

beforeEach(() => {
  stored = null;
  storedReads.length = 0;
  mockRefresh.mockReset();
  mockRefresh.mockResolvedValue('locked');
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
