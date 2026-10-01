/**
 * resolveAgentEndpoint / resolveAgentModelRoute over a stubbed secrets table
 * (docs/design/agent-model-endpoint.md §1, §2). The stub returns every row for
 * every query, so these also pin that the resolvers re-check purpose and scope
 * in code rather than trusting the WHERE clause.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

type Row = {
  id: string; purpose: string; encryptedValue?: string; workspaceId: string | null; accountId: string | null;
  userId?: string | null; label?: string | null; healthStatus?: string; updatedAt?: Date; tokenExpiresAt?: Date | null;
};
let rows: Row[] = [];
let policy: 'team' | 'own' = 'team';

mock.module('../db', () => ({ db: { query: { secrets: { findMany: async () => rows } } } }));
mock.module('../secrets', () => ({ decrypt: (v: string) => v }));
mock.module('../inference-keys', () => ({ loadInferenceKeyPolicy: async () => policy }));

const { resolveAgentEndpoint, resolveAgentModelRoute, endpointWinsRanking } = await import('../agent-endpoint');

const WS = 'ws-1';
const ACC = 'acc-1';
const custom = (baseUrl: string, apiKey: string) => JSON.stringify({ kind: 'anthropic-compatible', baseUrl, apiKey, authHeader: 'authorization' });
const endpointRow = (o: Partial<Row> & { id: string }): Row => ({
  purpose: 'agent_endpoint', workspaceId: null, accountId: null, userId: null, healthStatus: 'unknown',
  updatedAt: new Date('2026-01-01'), encryptedValue: custom('https://litellm.example.com', `key-${o.id}`), ...o,
});
const cred = (purpose: string, o: Partial<Row> = {}): Row => ({
  id: `${purpose}-${o.workspaceId ?? o.accountId ?? 'team'}`, purpose, workspaceId: null, accountId: null, healthStatus: 'healthy',
  tokenExpiresAt: new Date('2027-01-01'), ...o,
});

beforeEach(() => { rows = []; policy = 'team'; });

describe('resolveAgentEndpoint', () => {
  it('null with no row, and ignores rows of other purposes', async () => {
    rows = [cred('anthropic_api_key'), { ...cred('inference_key'), label: 'litellm', encryptedValue: 'x' }];
    expect(await resolveAgentEndpoint({ teamId: 't', workspaceId: WS })).toBeNull();
  });

  it('workspace beats team; revoked skipped; newest first', async () => {
    rows = [
      endpointRow({ id: 'team' }),
      endpointRow({ id: 'ws', workspaceId: WS }),
      endpointRow({ id: 'other-ws', workspaceId: 'ws-2', updatedAt: new Date('2026-06-01') }),
    ];
    const r = await resolveAgentEndpoint({ teamId: 't', workspaceId: WS });
    expect(r?.secretId).toBe('ws');
    expect(r?.scope).toBe('workspace');
    expect(r?.apiKey).toBe('key-ws');

    rows = [endpointRow({ id: 'ws', workspaceId: WS, healthStatus: 'revoked' }), endpointRow({ id: 'team' })];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.secretId).toBe('team');

    rows = [endpointRow({ id: 'old' }), endpointRow({ id: 'new', updatedAt: new Date('2026-05-01') })];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.secretId).toBe('new');
  });

  it('never resolves an account- or person-scoped row', async () => {
    rows = [endpointRow({ id: 'acct', accountId: ACC }), endpointRow({ id: 'person', userId: 'u-1' })];
    expect(await resolveAgentEndpoint({ teamId: 't', workspaceId: WS })).toBeNull();
  });

  it('a gateway reference uses the gateway key and derived base, even under key policy own', async () => {
    policy = 'own';
    rows = [
      endpointRow({ id: 'ref', encryptedValue: JSON.stringify({ kind: 'gateway' }) }),
      { id: 'gw', purpose: 'inference_key', label: 'litellm', workspaceId: null, accountId: null, userId: null, encryptedValue: JSON.stringify({ apiKey: 'sk-gw', baseUrl: 'https://litellm.example.com/v1' }) },
    ];
    const r = await resolveAgentEndpoint({ teamId: 't', workspaceId: WS });
    expect(r).toMatchObject({ kind: 'gateway', baseUrl: 'https://litellm.example.com', apiKey: 'sk-gw', authHeader: 'authorization', secretId: 'ref', scope: 'team' });
  });

  it('a gateway reference with no gateway resolves to nothing', async () => {
    rows = [endpointRow({ id: 'ref', encryptedValue: JSON.stringify({ kind: 'gateway' }) })];
    expect(await resolveAgentEndpoint({ teamId: 't', workspaceId: WS })).toBeNull();
  });

  it('an unreadable row is skipped, never thrown', async () => {
    rows = [endpointRow({ id: 'bad', workspaceId: WS, encryptedValue: 'garbage' }), endpointRow({ id: 'team' })];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.secretId).toBe('team');
  });
});

describe('endpointWinsRanking: most specific scope wins, tie to the endpoint', () => {
  it('pure table', () => {
    expect(endpointWinsRanking('team', [])).toBe(true);
    expect(endpointWinsRanking('team', ['team'])).toBe(true);
    expect(endpointWinsRanking('team', ['team', 'team'])).toBe(true);
    expect(endpointWinsRanking('team', ['account'])).toBe(false);
    expect(endpointWinsRanking('team', ['workspace'])).toBe(false);
    expect(endpointWinsRanking('workspace', ['workspace'])).toBe(true);
    expect(endpointWinsRanking('workspace', ['workspace', 'account', 'team'])).toBe(true);
  });
});

describe('resolveAgentModelRoute (§2 cases)', () => {
  const route = () => resolveAgentModelRoute({ teamId: 't', workspaceId: WS, accountId: ACC });

  it('no endpoint ⇒ null (today\'s behaviour)', async () => {
    rows = [cred('anthropic_api_key'), cred('oauth_token'), cred('claude_credential')];
    expect(await route()).toBeNull();
  });

  it('team endpoint + team seat ⇒ endpoint (tie)', async () => {
    for (const p of ['oauth_token', 'anthropic_api_key', 'claude_credential']) {
      rows = [endpointRow({ id: 'team' }), cred(p)];
      expect((await route())?.winner).toBe('endpoint');
    }
  });

  it('team endpoint + workspace Anthropic key ⇒ that workspace stays on Anthropic', async () => {
    for (const p of ['oauth_token', 'anthropic_api_key', 'claude_credential']) {
      rows = [endpointRow({ id: 'team' }), cred(p, { workspaceId: WS })];
      const d = await route();
      expect(d?.winner).toBe('anthropic');
      expect(d?.winner === 'anthropic' && d.beatenBy).toBe('workspace');
    }
  });

  it('team endpoint + account-wide key for this account ⇒ Anthropic; for another account ⇒ endpoint', async () => {
    rows = [endpointRow({ id: 'team' }), cred('anthropic_api_key', { accountId: ACC })];
    expect((await route())?.winner).toBe('anthropic');
    rows = [endpointRow({ id: 'team' }), cred('anthropic_api_key', { accountId: 'acc-other' })];
    expect((await route())?.winner).toBe('endpoint');
  });

  it('workspace endpoint beats everything, including a workspace key (tie)', async () => {
    rows = [endpointRow({ id: 'ws', workspaceId: WS }), cred('anthropic_api_key', { workspaceId: WS }), cred('oauth_token', { accountId: ACC })];
    expect((await route())?.winner).toBe('endpoint');
  });

  it('another workspace\'s key, a revoked key and a dead claude_credential do not compete', async () => {
    rows = [
      endpointRow({ id: 'team' }),
      cred('anthropic_api_key', { workspaceId: 'ws-2' }),
      cred('oauth_token', { workspaceId: WS, healthStatus: 'revoked' }),
      cred('claude_credential', { workspaceId: WS, tokenExpiresAt: null }),
    ];
    expect((await route())?.winner).toBe('endpoint');
  });
});
