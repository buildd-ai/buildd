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

const { resolveAgentEndpoint, resolveAgentModelRoute, endpointWinsRanking, hasOpenAiCompatibleAgentEndpoint } = await import('../agent-endpoint');

const WS = 'ws-1';
const ACC = 'acc-1';
const custom = (baseUrl: string, apiKey: string) => JSON.stringify({ kind: 'anthropic-compatible', baseUrl, apiKey, authHeader: 'authorization' });
const openRouter = (apiKey: string) => JSON.stringify({ kind: 'openrouter', apiKey, authHeader: 'authorization' });
const endpointRow = (o: Partial<Row> & { id: string }): Row => ({
  purpose: 'agent_endpoint', workspaceId: null, accountId: null, userId: null, healthStatus: 'unknown',
  updatedAt: new Date('2026-01-01'), encryptedValue: custom('https://litellm.example.com', `key-${o.id}`), ...o,
});
/** An endpoint with an OpenAI-compatible route (openrouter kind), for Codex. */
const openAiEndpointRow = (o: Partial<Row> & { id: string }): Row => ({
  purpose: 'agent_endpoint', workspaceId: null, accountId: null, userId: null, healthStatus: 'unknown',
  updatedAt: new Date('2026-01-01'), encryptedValue: openRouter(`key-${o.id}`), ...o,
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

describe('resolveAgentModelRoute: backend: "codex" ranks against the Codex-side credentials', () => {
  const route = (backend: 'claude' | 'codex' = 'codex') => resolveAgentModelRoute({ teamId: 't', workspaceId: WS, accountId: ACC, backend });

  it('an Anthropic-side credential never competes for a Codex task', async () => {
    rows = [endpointRow({ id: 'team' }), cred('anthropic_api_key', { workspaceId: WS }), cred('oauth_token', { workspaceId: WS }), cred('claude_credential', { workspaceId: WS })];
    expect((await route('codex'))?.winner).toBe('endpoint');
  });

  it('team endpoint + team-wide openai_api_key or codex_credential ⇒ endpoint (tie)', async () => {
    for (const p of ['openai_api_key', 'codex_credential']) {
      rows = [endpointRow({ id: 'team' }), cred(p)];
      expect((await route())?.winner).toBe('endpoint');
    }
  });

  it('team endpoint + a workspace-scoped openai_api_key/codex_credential ⇒ that workspace stays on it', async () => {
    for (const p of ['openai_api_key', 'codex_credential']) {
      rows = [endpointRow({ id: 'team' }), cred(p, { workspaceId: WS })];
      const d = await route();
      expect(d?.winner).toBe('anthropic');
      expect(d?.winner === 'anthropic' && d.beatenBy).toBe('workspace');
    }
  });

  it('the same rows rank differently by backend: a workspace anthropic_api_key does not block Codex, and vice versa', async () => {
    rows = [endpointRow({ id: 'team' }), cred('anthropic_api_key', { workspaceId: WS })];
    expect((await route('codex'))?.winner).toBe('endpoint');
    expect((await route('claude'))?.winner).toBe('anthropic');

    rows = [endpointRow({ id: 'team' }), cred('openai_api_key', { workspaceId: WS })];
    expect((await route('codex'))?.winner).toBe('anthropic');
    expect((await route('claude'))?.winner).toBe('endpoint');
  });

  it('defaults to the Claude purposes when backend is omitted', async () => {
    rows = [endpointRow({ id: 'team' }), cred('anthropic_api_key', { workspaceId: WS })];
    expect((await resolveAgentModelRoute({ teamId: 't', workspaceId: WS, accountId: ACC }))?.winner).toBe('anthropic');
  });
});

describe('hasOpenAiCompatibleAgentEndpoint', () => {
  it('false with no endpoint row', async () => {
    rows = [];
    expect(await hasOpenAiCompatibleAgentEndpoint({ teamId: 't', workspaceId: WS })).toBe(false);
  });

  it('false for an anthropic-compatible-only endpoint', async () => {
    rows = [endpointRow({ id: 'team' })];
    expect(await hasOpenAiCompatibleAgentEndpoint({ teamId: 't', workspaceId: WS })).toBe(false);
  });

  it('true for an openrouter endpoint (has an OpenAI-compatible route)', async () => {
    rows = [openAiEndpointRow({ id: 'team' })];
    expect(await hasOpenAiCompatibleAgentEndpoint({ teamId: 't', workspaceId: WS })).toBe(true);
  });
});
