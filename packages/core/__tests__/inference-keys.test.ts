import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

/**
 * One resolver for every API-token model key: chat turns, inference calls and
 * decision calls. Precedence is most specific first — the caller's own key,
 * then the workspace key, then the team key — and an env var only outside
 * production. A key must never reach a provider it was not issued for, and a
 * personal key must never serve anyone but its owner.
 */

let secretRows: any[] = [];
let lastWhere: any = null;

mock.module('../db', () => ({
  db: {
    query: {
      secrets: {
        findMany: (q: any) => { lastWhere = q?.where; return Promise.resolve(secretRows); },
      },
    },
  },
}));

mock.module('../db/schema', () => ({
  secrets: {
    id: 'id', teamId: 'team_id', accountId: 'account_id', userId: 'user_id', purpose: 'purpose',
    label: 'label', encryptedValue: 'encrypted_value', workspaceId: 'workspace_id',
    healthStatus: 'health_status', updatedAt: 'updated_at',
  },
}));

mock.module('../secrets', () => ({
  decrypt: (s: string) => {
    if (s === 'enc:BROKEN') throw new Error('bad key');
    return s.replace(/^enc:/, '');
  },
}));

mock.module('drizzle-orm', () => ({
  and: (...c: any[]) => ({ __and: c }),
  eq: (f: any, v: any) => ({ __eq: [f, v] }),
  or: (...c: any[]) => ({ __or: c }),
  isNull: (f: any) => ({ __isNull: f }),
  inArray: (f: any, v: any) => ({ __in: [f, v] }),
  sql: (s: any) => ({ __sql: s }),
}));

const {
  resolveInferenceKey,
  resolveInferenceCredential,
  maskKeyLast4,
  verifyProviderKey,
  envKeysAllowed,
} = await import('../inference-keys');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 's-1', purpose: 'inference_key', label: 'openrouter', encryptedValue: 'enc:team',
    accountId: null, userId: null, workspaceId: null, healthStatus: 'unknown',
    updatedAt: new Date('2026-09-01'),
    ...over,
  };
}

const ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'BUILDD_ALLOW_ENV_INFERENCE_KEYS'];
let savedEnv: Record<string, string | undefined> = {};
let savedNodeEnv: string | undefined;

beforeEach(() => {
  secretRows = [];
  lastWhere = null;
  savedEnv = Object.fromEntries(ENV_VARS.map(k => [k, process.env[k]]));
  savedNodeEnv = process.env.NODE_ENV;
  for (const k of ENV_VARS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  process.env.NODE_ENV = savedNodeEnv;
});

describe('resolveInferenceKey precedence', () => {
  it('prefers the caller\'s own key, then the workspace key, then the team key', async () => {
    secretRows = [
      row({ id: 'team', encryptedValue: 'enc:team' }),
      row({ id: 'ws', workspaceId: 'ws-1', encryptedValue: 'enc:ws' }),
      row({ id: 'mine', userId: 'u-1', encryptedValue: 'enc:mine' }),
    ];
    const base = { provider: 'openrouter' as const, teamId: 't-1', workspaceId: 'ws-1' };
    expect(await resolveInferenceKey({ ...base, userId: 'u-1' })).toBe('mine');
    expect(await resolveInferenceKey(base)).toBe('ws');
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBe('team');
  });

  it('never hands one user\'s key to another user, or to a caller with no user', async () => {
    secretRows = [row({ userId: 'someone-else', encryptedValue: 'enc:theirs' })];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1', userId: 'u-1' })).toBeNull();
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBeNull();
  });

  it('scopes the query to the caller\'s user (NULL or equal)', async () => {
    await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1', userId: 'u-1' });
    const text = JSON.stringify(lastWhere);
    expect(text).toContain('"__isNull":"user_id"');
    expect(text).toContain('["user_id","u-1"]');
  });

  it('never uses another workspace\'s key', async () => {
    secretRows = [row({ workspaceId: 'other-ws', encryptedValue: 'enc:other' })];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1', workspaceId: 'ws-1' })).toBeNull();
  });

  it('rejects rows labelled for a different provider even if the query returns them', async () => {
    secretRows = [row({ label: 'anthropic', encryptedValue: 'enc:sk-ant' })];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBeNull();
    expect(await resolveInferenceKey({ provider: 'openai', teamId: 't-1' })).toBeNull();
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 't-1' })).toBe('sk-ant');
  });

  it('matches the provider label case-insensitively', async () => {
    secretRows = [row({ label: 'OpenAI', encryptedValue: 'enc:sk-oa' })];
    expect(await resolveInferenceKey({ provider: 'openai', teamId: 't-1' })).toBe('sk-oa');
  });

  it('accepts anthropic_api_key for Anthropic only', async () => {
    secretRows = [row({ purpose: 'anthropic_api_key', label: null, encryptedValue: 'enc:sk-ant' })];
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 't-1' })).toBe('sk-ant');
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBeNull();
    expect(await resolveInferenceKey({ provider: 'openai', teamId: 't-1' })).toBeNull();
  });

  it('accepts the legacy decision_key for OpenRouter, so one key serves chat and decisions', async () => {
    secretRows = [row({ purpose: 'decision_key', label: null, encryptedValue: 'enc:dec' })];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBe('dec');
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 't-1' })).toBeNull();
  });

  it('prefers inference_key over decision_key at the same scope by default', async () => {
    secretRows = [
      row({ purpose: 'decision_key', label: null, encryptedValue: 'enc:dec' }),
      row({ encryptedValue: 'enc:inf' }),
    ];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBe('inf');
  });

  it('a caller-supplied purpose order wins within a scope, but never over scope', async () => {
    secretRows = [
      row({ id: 'inf-team', encryptedValue: 'enc:inf-team' }),
      row({ id: 'dec-team', purpose: 'decision_key', label: null, encryptedValue: 'enc:dec-team' }),
    ];
    const purposes = ['decision_key', 'inference_key'];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1', purposes })).toBe('dec-team');
    secretRows.push(row({ id: 'inf-ws', workspaceId: 'ws-1', encryptedValue: 'enc:inf-ws' }));
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1', workspaceId: 'ws-1', purposes })).toBe('inf-ws');
  });

  it('never accepts a purpose outside the provider\'s set, even when the caller asks', async () => {
    secretRows = [row({ purpose: 'oauth_token', label: null, encryptedValue: 'enc:oat' })];
    expect(await resolveInferenceKey({
      provider: 'anthropic', teamId: 't-1', purposes: ['oauth_token', 'inference_key'],
    })).toBeNull();
  });

  it('an account-scoped key serves its own account first, and never another account', async () => {
    secretRows = [
      row({ id: 'team', encryptedValue: 'enc:team' }),
      row({ id: 'acct', accountId: 'a-1', encryptedValue: 'enc:acct' }),
    ];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1', accountId: 'a-1' })).toBe('acct');
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1', accountId: 'a-2' })).toBe('team');
  });

  it('keeps legacy account-scoped rows usable as a last resort for callers with no account', async () => {
    // POST /api/secrets used to default inference keys to the calling API key's
    // account; inferenceCall (cron, no account) has always used those rows.
    secretRows = [row({ id: 'acct', accountId: 'a-1', encryptedValue: 'enc:acct' })];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBe('acct');
    secretRows.push(row({ id: 'team', encryptedValue: 'enc:team' }));
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBe('team');
  });

  it('does not let a revoked row shadow a healthy one at the same scope', async () => {
    secretRows = [
      row({ id: 'dead', healthStatus: 'revoked', encryptedValue: 'enc:dead', updatedAt: new Date('2026-09-20') }),
      row({ id: 'live', healthStatus: 'healthy', encryptedValue: 'enc:live', updatedAt: new Date('2026-09-01') }),
    ];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBe('live');
  });

  it('skips a row that cannot be decrypted and tries the next one', async () => {
    secretRows = [
      row({ id: 'broken', userId: 'u-1', encryptedValue: 'enc:BROKEN' }),
      row({ id: 'team', encryptedValue: 'enc:team' }),
    ];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1', userId: 'u-1' })).toBe('team');
  });

  it('returns null for a provider with no API-key form (openai-codex)', async () => {
    secretRows = [row({ label: 'openai-codex' })];
    expect(await resolveInferenceKey({ provider: 'openai-codex' as any, teamId: 't-1' })).toBeNull();
  });
});

describe('resolveInferenceCredential', () => {
  it('reports which scope and row the key came from', async () => {
    secretRows = [row({ id: 'mine', userId: 'u-1', encryptedValue: 'enc:mine' })];
    expect(await resolveInferenceCredential({ provider: 'openrouter', teamId: 't-1', userId: 'u-1' }))
      .toEqual({ key: 'mine', scope: 'user', secretId: 'mine', purpose: 'inference_key' });
  });

  it('reports env as its own scope', async () => {
    process.env.NODE_ENV = 'development';
    process.env.OPENAI_API_KEY = 'sk-env';
    expect(await resolveInferenceCredential({ provider: 'openai', teamId: 't-1' }))
      .toEqual({ key: 'sk-env', scope: 'env', secretId: null, purpose: null });
  });
});

describe('env fallback', () => {
  it('uses the provider env var outside production when no row matched', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ANTHROPIC_API_KEY = 'env-ant';
    process.env.OPENAI_API_KEY = 'env-oa';
    process.env.OPENROUTER_API_KEY = 'env-or';
    expect(await resolveInferenceKey({ provider: 'anthropic', teamId: 't-1' })).toBe('env-ant');
    expect(await resolveInferenceKey({ provider: 'openai', teamId: 't-1' })).toBe('env-oa');
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBe('env-or');
  });

  it('never uses env in production — a stray deploy var must not start spending for every team', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENROUTER_API_KEY = 'env-or';
    expect(envKeysAllowed()).toBe(false);
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBeNull();
  });

  it('lets a self-hosted production deploy opt in explicitly', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BUILDD_ALLOW_ENV_INFERENCE_KEYS = '1';
    process.env.OPENROUTER_API_KEY = 'env-or';
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBe('env-or');
  });

  it('a stored row always beats env', async () => {
    process.env.NODE_ENV = 'development';
    process.env.OPENROUTER_API_KEY = 'env-or';
    secretRows = [row({ encryptedValue: 'enc:team' })];
    expect(await resolveInferenceKey({ provider: 'openrouter', teamId: 't-1' })).toBe('team');
  });
});

describe('maskKeyLast4', () => {
  it('keeps only the last four characters', () => {
    expect(maskKeyLast4('sk-or-v1-abcdef1234')).toBe('1234');
  });
  it('never reveals most of a short value', () => {
    expect(maskKeyLast4('abc')).toBe('');
    expect(maskKeyLast4('abcdefg')).toBe('');
  });
});

describe('verifyProviderKey', () => {
  const ok = () => Promise.resolve(new Response('{}', { status: 200 }));

  it('calls a free, read-only endpoint per provider with the right auth header', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return ok();
    };
    await verifyProviderKey('anthropic', 'sk-ant', { fetcher });
    await verifyProviderKey('openai', 'sk-oa', { fetcher });
    await verifyProviderKey('openrouter', 'sk-or', { fetcher });
    expect(seen[0].url).toStartWith('https://api.anthropic.com/v1/models');
    expect(seen[0].headers['x-api-key']).toBe('sk-ant');
    expect(seen[1].url).toStartWith('https://api.openai.com/v1/models');
    expect(seen[1].headers.Authorization).toBe('Bearer sk-oa');
    expect(seen[2].url).toBe('https://openrouter.ai/api/v1/key');
    expect(seen[2].headers.Authorization).toBe('Bearer sk-or');
  });

  it('maps 200 to healthy and 401/403 to revoked', async () => {
    expect(await verifyProviderKey('openai', 'k', { fetcher: ok })).toEqual({ health: 'healthy', error: null });
    const r401 = await verifyProviderKey('openai', 'k', {
      fetcher: () => Promise.resolve(new Response('nope', { status: 401 })),
    });
    expect(r401.health).toBe('revoked');
    expect(r401.error).toContain('401');
  });

  it('treats other failures as unknown, not revoked — a provider outage must not kill a key', async () => {
    const r500 = await verifyProviderKey('openai', 'k', {
      fetcher: () => Promise.resolve(new Response('boom', { status: 503 })),
    });
    expect(r500.health).toBe('unknown');
    const rNet = await verifyProviderKey('openai', 'k', { fetcher: () => Promise.reject(new Error('ECONNRESET')) });
    expect(rNet.health).toBe('unknown');
    expect(rNet.error).toContain('ECONNRESET');
  });

  it('never echoes the key in the error text', async () => {
    const r = await verifyProviderKey('openai', 'sk-secret-value', {
      fetcher: () => Promise.resolve(new Response('bad key sk-secret-value', { status: 401 })),
    });
    expect(r.error ?? '').not.toContain('sk-secret-value');
  });
});
