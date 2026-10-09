/**
 * Chat and inference resolve keys through the provider resolver. These pin the
 * caller-side narrowing (`purposes`, `scopes`, `accept`) that keeps
 * `resolveInferenceCredential` and `resolveLiteLLMGateway` picking exactly
 * what they picked before they became wrappers.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

let dbRows: unknown[] = [];
let teamRow: unknown = undefined;
mock.module('../db', () => ({
  db: { query: { secrets: { findMany: async () => dbRows }, teams: { findFirst: async () => teamRow } } },
}));
mock.module('../secrets', () => ({
  decrypt: (v: string) => {
    if (v.startsWith('bad:')) throw new Error('bad ciphertext');
    return v.replace(/^enc:/, '');
  },
}));

const { selectProviderCredential, eligibleProviders, resolvePurposes } = await import('../providers/resolve');
const { surfacePolicy } = await import('../providers');
const { resolveInferenceCredential } = await import('../inference-keys');
const { resolveLiteLLMGateway } = await import('../litellm-gateway');

const W = 'ws-1';
let seq = 0;
function row(over: Record<string, unknown> & { purpose: string }) {
  seq++;
  return {
    id: `s${seq}`, label: null, encryptedValue: `enc:SECRET-${seq}`, accountId: null, workspaceId: null,
    userId: null, healthStatus: 'healthy', tokenExpiresAt: null,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000), ...over,
  };
}
const gw = (over: Record<string, unknown> = {}, baseUrl = 'https://litellm.example.com/v1') =>
  row({ purpose: 'inference_key', label: 'litellm', encryptedValue: `enc:${JSON.stringify({ apiKey: `k${seq + 1}`, baseUrl })}`, ...over });

beforeEach(() => {
  dbRows = [];
  teamRow = undefined;
  delete process.env.OPENAI_API_KEY;
});

describe('selectProviderCredential narrowing', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    workspaceId: W, accountId: null, requesterUserId: null, surface: 'chat' as const,
    eligible: eligibleProviders('chat', ['openrouter']).eligible,
    policy: surfacePolicy(null, 'chat'), env: { allowed: false, values: {} }, ...over,
  });
  const decrypt = (v: string) => v.replace(/^enc:/, '');

  it('purposes reorder within a scope and drop the rest', () => {
    const inf = row({ purpose: 'inference_key', label: 'openrouter' });
    const dec = row({ purpose: 'decision_key' });
    expect(selectProviderCredential([inf, dec], ctx(), decrypt).source?.secretId).toBe(inf.id);
    expect(selectProviderCredential([inf, dec], ctx({ purposes: ['decision_key', 'inference_key'] }), decrypt).source?.secretId).toBe(dec.id);
    expect(selectProviderCredential([inf], ctx({ purposes: ['decision_key'] }), decrypt).none).toBe(true);
    expect(resolvePurposes('chat', ['openrouter'], ['decision_key'])).toEqual(['decision_key']);
  });

  it('scopes exclude a scope the policy would allow, including env', () => {
    const acct = row({ purpose: 'inference_key', label: 'openrouter', accountId: 'a-1' });
    expect(selectProviderCredential([acct], ctx(), decrypt).scope).toBe('account');
    expect(selectProviderCredential([acct], ctx({ scopes: ['workspace', 'team'] }), decrypt).none).toBe(true);
    const env = { allowed: true, values: { OPENROUTER_API_KEY: 'env-or' } };
    expect(selectProviderCredential([], ctx({ env }), decrypt).scope).toBe('env');
    expect(selectProviderCredential([], ctx({ env, scopes: ['team'] }), decrypt).none).toBe(true);
  });

  it('accept skips an unusable value and tries the next row', () => {
    const ws = row({ purpose: 'inference_key', label: 'openrouter', workspaceId: W, encryptedValue: 'enc:junk' });
    const team = row({ purpose: 'inference_key', label: 'openrouter', encryptedValue: 'enc:good' });
    const r = selectProviderCredential([ws, team], ctx({ accept: (v: string) => v === 'good' }), decrypt);
    expect(r.source?.secretId).toBe(team.id);
    expect(r.why.some(w => w.includes('not a usable value'))).toBe(true);
  });
});

describe('scopeSpecificity ≡ credentialScopeRank', () => {
  it('agrees on every row scope × target', async () => {
    const { scopeSpecificity } = await import('../providers/resolve');
    const { credentialScopeRank } = await import('../secrets/team-scope');
    const vals = [null, 'x', 'y'];
    let n = 0;
    for (const userId of vals) for (const workspaceId of vals) for (const accountId of vals)
      for (const tw of vals) for (const ta of vals) {
        const r = { userId, workspaceId, accountId };
        const t = { workspaceId: tw, accountId: ta };
        expect(scopeSpecificity(r, t)).toBe(credentialScopeRank(r as never, t as never));
        n++;
      }
    expect(n).toBe(243);
  });
});

describe('resolveInferenceCredential (wrapper)', () => {
  it('never serves an agent-only legacy storage to chat (openai_api_key)', async () => {
    dbRows = [row({ purpose: 'openai_api_key' })];
    expect(await resolveInferenceCredential({ provider: 'openai', teamId: 't', keyPolicy: 'team_or_own' })).toBeNull();
  });
});

describe('resolveLiteLLMGateway (wrapper)', () => {
  it('a workspace gateway beats the team one; another workspace never applies', async () => {
    const team = gw();
    const ws = gw({ workspaceId: W }, 'https://ws.example.com/v1');
    dbRows = [team, ws, gw({ workspaceId: 'ws-2' }, 'https://other.example.com/v1')];
    expect((await resolveLiteLLMGateway({ teamId: 't', workspaceId: W }))?.baseURL).toBe('https://ws.example.com/v1');
    expect((await resolveLiteLLMGateway({ teamId: 't' }))?.baseURL).toBe('https://litellm.example.com/v1');
  });

  it('ignores personal and account-scoped rows: a gateway is the organisation’s', async () => {
    dbRows = [gw({ userId: 'u-1' }), gw({ accountId: 'a-1' })];
    expect(await resolveLiteLLMGateway({ teamId: 't', workspaceId: W })).toBeNull();
  });

  it('skips a row that is not a well-formed gateway, or cannot be decrypted, and tries the next', async () => {
    dbRows = [
      row({ purpose: 'inference_key', label: 'litellm', workspaceId: W, encryptedValue: 'enc:not-json' }),
      row({ purpose: 'inference_key', label: 'litellm', workspaceId: W, encryptedValue: 'bad:x' }),
      gw(),
    ];
    expect((await resolveLiteLLMGateway({ teamId: 't', workspaceId: W }))?.baseURL).toBe('https://litellm.example.com/v1');
  });

  it('a healthy row beats a newer revoked one in the same scope', async () => {
    const live = gw({}, 'https://live.example.com/v1');
    dbRows = [live, gw({ healthStatus: 'revoked' }, 'https://dead.example.com/v1')];
    expect((await resolveLiteLLMGateway({ teamId: 't' }))?.baseURL).toBe('https://live.example.com/v1');
  });

  it("is null under 'own', unless the caller ignores the key policy (agent endpoint reference)", async () => {
    dbRows = [gw()];
    teamRow = { inferenceKeyPolicy: 'own' };
    expect(await resolveLiteLLMGateway({ teamId: 't' })).toBeNull();
    expect(await resolveLiteLLMGateway({ teamId: 't' }, { ignoreKeyPolicy: true })).not.toBeNull();
    teamRow = { credentialPolicy: 'personal_only' };
    expect(await resolveLiteLLMGateway({ teamId: 't' })).toBeNull();
  });
});
