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

  it('toolSearch comes from the winning row: a workspace row carries its own value', async () => {
    const withCaps = (kind: string, caps?: object) => JSON.stringify({
      kind, baseUrl: 'https://litellm.example.com', apiKey: 'k', authHeader: 'authorization', ...(caps ? { capabilities: caps } : {}),
    });
    // Team row OpenRouter (on by default), workspace row custom URL with it off.
    rows = [
      endpointRow({ id: 'team', encryptedValue: withCaps('openrouter') }),
      endpointRow({ id: 'ws', workspaceId: WS, encryptedValue: withCaps('anthropic-compatible') }),
    ];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.toolSearch).toBe(false);
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: 'ws-2' }))?.toolSearch).toBe(true);
    // And the reverse: a workspace opt-in under a team row that has it off.
    rows = [
      endpointRow({ id: 'team', encryptedValue: withCaps('openrouter', { toolSearch: false }) }),
      endpointRow({ id: 'ws', workspaceId: WS, encryptedValue: withCaps('anthropic-compatible', { toolSearch: true }) }),
    ];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.toolSearch).toBe(true);
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: 'ws-2' }))?.toolSearch).toBe(false);
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

  const orKey = (o: Partial<Row> & { id: string; value: string }): Row => ({
    purpose: 'inference_key', label: 'openrouter', workspaceId: null, accountId: null, userId: null,
    healthStatus: 'healthy', updatedAt: new Date('2026-01-01'), encryptedValue: o.value, ...o,
  });
  const orRef = JSON.stringify({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', authHeader: 'authorization' });

  it('an openrouter reference routes the stored OpenRouter key, even under key policy own', async () => {
    policy = 'own';
    rows = [endpointRow({ id: 'ref', encryptedValue: orRef }), orKey({ id: 'or', value: 'sk-or-stored' })];
    const r = await resolveAgentEndpoint({ teamId: 't', workspaceId: WS });
    expect(r).toMatchObject({ kind: 'openrouter', baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-or-stored', secretId: 'ref', scope: 'team' });
    expect(r?.openAiBaseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('an openrouter reference resolves at its own scope or broader, never narrower or personal', async () => {
    // Team reference: a workspace key or a person's key never serves it.
    rows = [
      endpointRow({ id: 'ref', encryptedValue: orRef }),
      orKey({ id: 'ws-key', value: 'sk-or-ws', workspaceId: WS }),
      orKey({ id: 'mine', value: 'sk-or-mine', userId: 'u-1' }),
      orKey({ id: 'acct', value: 'sk-or-acct', accountId: ACC }),
    ];
    expect(await resolveAgentEndpoint({ teamId: 't', workspaceId: WS })).toBeNull();
    // Workspace reference: its own workspace key over the team's.
    rows = [
      endpointRow({ id: 'ref', workspaceId: WS, encryptedValue: orRef }),
      orKey({ id: 'team-key', value: 'sk-or-team' }),
      orKey({ id: 'ws-key', value: 'sk-or-ws', workspaceId: WS }),
    ];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.apiKey).toBe('sk-or-ws');
    // ...and the team key when the workspace has none.
    rows = [endpointRow({ id: 'ref', workspaceId: WS, encryptedValue: orRef }), orKey({ id: 'team-key', value: 'sk-or-team' })];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.apiKey).toBe('sk-or-team');
  });

  it('an openrouter reference reads the legacy decision_key, canonical first', async () => {
    rows = [
      endpointRow({ id: 'ref', encryptedValue: orRef }),
      orKey({ id: 'legacy', purpose: 'decision_key', label: null, value: 'sk-or-legacy', updatedAt: new Date('2026-06-01') }),
    ];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.apiKey).toBe('sk-or-legacy');
    rows.push(orKey({ id: 'canon', value: 'sk-or-canon' }));
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.apiKey).toBe('sk-or-canon');
  });

  it('an openrouter reference with no stored key resolves to nothing; a legacy inline key still routes', async () => {
    rows = [endpointRow({ id: 'ref', encryptedValue: orRef })];
    expect(await resolveAgentEndpoint({ teamId: 't', workspaceId: WS })).toBeNull();
    // Inline (legacy) wins over the stored key: the row says which key it uses.
    rows = [endpointRow({ id: 'inline', encryptedValue: openRouter('sk-or-inline') }), orKey({ id: 'or', value: 'sk-or-stored' })];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.apiKey).toBe('sk-or-inline');
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

// Provider parity: the team's API key competes with the endpoint wherever it
// is stored, canonical (`inference_key` + provider label) or legacy.
describe('resolveAgentModelRoute: canonical API-key storage competes like the legacy one', () => {
  const route = (backend: 'claude' | 'codex') => resolveAgentModelRoute({ teamId: 't', workspaceId: WS, accountId: ACC, backend });
  const key = (label: string, o: Partial<Row> = {}) => cred('inference_key', { id: `inference_key-${label}-${o.workspaceId ?? o.userId ?? 'team'}`, label, userId: null, ...o });

  it('a workspace canonical Anthropic key keeps that workspace off a team endpoint (Claude)', async () => {
    rows = [endpointRow({ id: 'team' }), key('anthropic', { workspaceId: WS })];
    const d = await route('claude');
    expect(d?.winner).toBe('anthropic');
    expect(d?.winner === 'anthropic' && d.beatenBy).toBe('workspace');
    expect((await route('codex'))?.winner).toBe('endpoint');
  });

  it('a workspace canonical OpenAI key keeps that workspace off a team endpoint (Codex)', async () => {
    rows = [endpointRow({ id: 'team' }), key('openai', { workspaceId: WS })];
    expect((await route('codex'))?.winner).toBe('anthropic');
    expect((await route('claude'))?.winner).toBe('endpoint');
  });

  it('a team canonical key ties a team endpoint, and the endpoint wins the tie', async () => {
    rows = [endpointRow({ id: 'team' }), key('anthropic'), key('openai')];
    expect((await route('claude'))?.winner).toBe('endpoint');
    expect((await route('codex'))?.winner).toBe('endpoint');
  });

  it('another provider’s chat key and a personal key never compete', async () => {
    rows = [
      endpointRow({ id: 'team' }),
      key('openrouter', { workspaceId: WS }),
      key('litellm', { workspaceId: WS }),
      key('anthropic', { workspaceId: WS, userId: 'user-1' }),
      key('openai', { workspaceId: WS, userId: 'user-1' }),
    ];
    expect((await route('claude'))?.winner).toBe('endpoint');
    expect((await route('codex'))?.winner).toBe('endpoint');
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

describe('appliesTo: a team endpoint narrowed to a list of workspaces', () => {
  const WS2 = 'ws-2';
  const listed = (appliesTo: string[], kind: 'custom' | 'openrouter' = 'custom') => {
    const base = kind === 'custom'
      ? { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: 'key-team', authHeader: 'authorization' }
      : { kind: 'openrouter', apiKey: 'key-team', authHeader: 'authorization' };
    return JSON.stringify({ ...base, appliesTo });
  };

  it('absent = all workspaces (unchanged behaviour)', async () => {
    rows = [endpointRow({ id: 'team' })];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.secretId).toBe('team');
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS2 }))?.secretId).toBe('team');
  });

  it('a listed workspace resolves the team row', async () => {
    rows = [endpointRow({ id: 'team', encryptedValue: listed([WS, 'ws-3']) })];
    expect(await resolveAgentEndpoint({ teamId: 't', workspaceId: WS })).toMatchObject({ secretId: 'team', scope: 'team' });
  });

  it('an unlisted workspace gets nothing, and a call with no workspace gets nothing', async () => {
    rows = [endpointRow({ id: 'team', encryptedValue: listed([WS]) })];
    expect(await resolveAgentEndpoint({ teamId: 't', workspaceId: WS2 })).toBeNull();
    expect(await resolveAgentEndpoint({ teamId: 't', workspaceId: null })).toBeNull();
  });

  it('a workspace row beats a team row that lists the workspace, and works for an unlisted one', async () => {
    rows = [endpointRow({ id: 'team', encryptedValue: listed([WS]) }), endpointRow({ id: 'ws', workspaceId: WS })];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.secretId).toBe('ws');
    rows = [endpointRow({ id: 'team', encryptedValue: listed([WS]) }), endpointRow({ id: 'ws2', workspaceId: WS2 })];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS2 }))?.secretId).toBe('ws2');
  });

  it('appliesTo on a workspace row is ignored: the row is that workspace\'s own', async () => {
    rows = [endpointRow({ id: 'ws', workspaceId: WS, encryptedValue: listed([WS2]) })];
    expect((await resolveAgentEndpoint({ teamId: 't', workspaceId: WS }))?.secretId).toBe('ws');
  });

  it('resolveAgentModelRoute honours it for both backends', async () => {
    rows = [endpointRow({ id: 'team', encryptedValue: listed([WS], 'openrouter') })];
    for (const backend of ['claude', 'codex'] as const) {
      expect((await resolveAgentModelRoute({ teamId: 't', workspaceId: WS, accountId: ACC, backend }))?.winner).toBe('endpoint');
      expect(await resolveAgentModelRoute({ teamId: 't', workspaceId: WS2, accountId: ACC, backend })).toBeNull();
    }
  });

  it('hasOpenAiCompatibleAgentEndpoint honours it', async () => {
    rows = [endpointRow({ id: 'team', encryptedValue: listed([WS], 'openrouter') })];
    expect(await hasOpenAiCompatibleAgentEndpoint({ teamId: 't', workspaceId: WS })).toBe(true);
    expect(await hasOpenAiCompatibleAgentEndpoint({ teamId: 't', workspaceId: WS2 })).toBe(false);
  });
});
