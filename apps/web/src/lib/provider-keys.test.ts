import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Provider keys as the settings UI manages them. The properties that matter:
 * plaintext never leaves (only last4), a key the provider rejects is never
 * stored, and a delete can only reach the exact scope the caller owns — a
 * member deleting their own key can't touch the team's, and vice versa.
 */

let rows: any[] = [];
let deletedWhere: unknown = null;
let findFirstWhere: unknown = null;
let updateSet: any = null;
const replaceScoped = mock(async (_v: string, _m: any) => 'new-id');

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      secrets: {
        findMany: async () => rows,
        findFirst: async (q: any) => { findFirstWhere = q.where; return rows[0]; },
      },
    },
    update: () => ({
      set: (s: any) => {
        updateSet = s;
        return {
          where: () => {
            const p = Promise.resolve(undefined) as any;
            p.returning = async () => [{
              id: 'new-id', purpose: 'inference_key', label: 'openrouter', encryptedValue: 'enc:sk-or-v1-stored-9876',
              accountId: null, userId: 'u-1', lastVerifiedAt: s.lastVerifiedAt,
              lastVerificationError: s.lastVerificationError, healthStatus: s.healthStatus, updatedAt: new Date('2026-09-26'),
            }];
            return p;
          },
        };
      },
    }),
    delete: () => ({
      where: (w: unknown) => { deletedWhere = w; return { returning: async () => [{ id: 'x' }] }; },
    }),
  },
}));

mock.module('@buildd/core/secrets', () => ({
  decrypt: (s: string) => s.replace(/^enc:/, ''),
  getSecretsProvider: () => ({ replaceScoped }),
}));

const { listProviderKeys, setProviderKey, deleteProviderKey, providerKeyProblem, sanitizeProviderKey } =
  await import('./provider-keys');

const dialect = new PgDialect();
const render = (w: unknown) => {
  const q = dialect.sqlToQuery(w as never);
  return { sql: q.sql.replace(/\s+/g, ' '), params: q.params };
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 's', purpose: 'inference_key', label: 'openrouter', encryptedValue: 'enc:sk-or-v1-team-key-1111',
    accountId: null, userId: null, healthStatus: 'healthy', lastVerifiedAt: null, lastVerificationError: null,
    updatedAt: new Date('2026-09-01'),
    ...over,
  };
}

const realFetch = globalThis.fetch;
let fetchStatus = 200;
beforeEach(() => {
  rows = [];
  deletedWhere = null;
  findFirstWhere = null;
  updateSet = null;
  replaceScoped.mockClear();
  fetchStatus = 200;
  globalThis.fetch = (async () => new Response('{}', { status: fetchStatus })) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('listProviderKeys', () => {
  it('returns one card per provider with masked team and personal keys, never plaintext', async () => {
    rows = [
      row({ id: 'team' }),
      row({ id: 'mine', userId: 'u-1', encryptedValue: 'enc:sk-or-v1-mine-key-2222' }),
      row({ id: 'theirs', userId: 'u-2', encryptedValue: 'enc:sk-or-v1-their-key-3333' }),
    ];
    const res = await listProviderKeys('t-1', 'u-1', true);
    expect(res.providers.map(p => p.provider)).toEqual(['anthropic', 'openai', 'openrouter']);
    const or = res.providers.find(p => p.provider === 'openrouter')!;
    expect(or.team?.last4).toBe('1111');
    expect(or.mine?.last4).toBe('2222');
    expect(or.membersWithOwnKey).toBe(2);
    const text = JSON.stringify(res);
    for (const secret of ['sk-or-v1-team-key-1111', 'sk-or-v1-mine-key-2222', 'sk-or-v1-their-key-3333']) {
      expect(text).not.toContain(secret);
    }
    // another member's key is never shown as mine
    expect(or.mine?.id).toBe('mine');
  });

  it('hides the member count from non-admins', async () => {
    rows = [row({ userId: 'u-2' })];
    const res = await listProviderKeys('t-1', 'u-1', false);
    expect(res.providers.every(p => p.membersWithOwnKey === null)).toBe(true);
    expect(res.providers.find(p => p.provider === 'openrouter')!.mine).toBeNull();
  });

  it('shows a key that already serves chat from elsewhere, labelled by source', async () => {
    rows = [
      row({ id: 'runner', purpose: 'anthropic_api_key', label: null, encryptedValue: 'enc:sk-ant-api03-runner-4444' }),
      row({ id: 'dec', purpose: 'decision_key', label: null, encryptedValue: 'enc:sk-or-v1-decision-5555' }),
    ];
    const res = await listProviderKeys('t-1', 'u-1', true);
    expect(res.providers.find(p => p.provider === 'anthropic')!.team?.source).toBe('anthropic_api_key');
    expect(res.providers.find(p => p.provider === 'openrouter')!.team?.source).toBe('decision_key');
  });

  it('prefers the canonical inference_key as the team key', async () => {
    rows = [
      row({ id: 'dec', purpose: 'decision_key', label: null, updatedAt: new Date('2026-09-20') }),
      row({ id: 'inf' }),
    ];
    const res = await listProviderKeys('t-1', 'u-1', true);
    expect(res.providers.find(p => p.provider === 'openrouter')!.team?.id).toBe('inf');
  });
});

describe('setProviderKey', () => {
  const input = { teamId: 't-1', userId: 'u-1', provider: 'openrouter' as const, scope: 'user' as const, value: '"sk-or-v1-0123456789abcdef"' };

  it('verifies, stores the sanitized value at the personal scope, and returns it masked', async () => {
    const res = await setProviderKey(input);
    expect(res.ok).toBe(true);
    expect(replaceScoped).toHaveBeenCalledWith('sk-or-v1-0123456789abcdef', {
      teamId: 't-1', purpose: 'inference_key', label: 'openrouter', userId: 'u-1',
    });
    expect(updateSet.healthStatus).toBe('healthy');
    if (res.ok) expect(JSON.stringify(res.key)).not.toContain('0123456789abcdef');
  });

  it('stores a team key with no user', async () => {
    await setProviderKey({ ...input, scope: 'team' });
    expect(replaceScoped.mock.calls[0][1].userId).toBeNull();
  });

  it('never stores a key the provider rejects', async () => {
    fetchStatus = 401;
    const res = await setProviderKey(input);
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(replaceScoped).not.toHaveBeenCalled();
  });

  it('stores with unknown health when the provider is unreachable', async () => {
    fetchStatus = 503;
    const res = await setProviderKey(input);
    expect(res.ok).toBe(true);
    expect(updateSet.healthStatus).toBe('unknown');
  });

  it('refuses a Claude subscription token for Anthropic', () => {
    expect(providerKeyProblem('anthropic', 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaa')).toContain('subscription');
    expect(providerKeyProblem('anthropic', 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa')).toBeNull();
    expect(providerKeyProblem('openai', 'short')).not.toBeNull();
  });

  it('strips one pair of wrapping quotes', () => {
    expect(sanitizeProviderKey("  'abc'  ")).toBe('abc');
  });
});

describe('deleteProviderKey', () => {
  it('a personal delete only matches the caller\'s row', async () => {
    await deleteProviderKey({ teamId: 't-1', userId: 'u-1', provider: 'openai', scope: 'user' });
    const { sql, params } = render(deletedWhere);
    expect(sql).toContain('"secrets"."user_id" = $');
    expect(params).toContain('u-1');
    expect(params).toContain('inference_key');
  });

  it('a team delete only matches the team row — never personal keys or runner keys', async () => {
    await deleteProviderKey({ teamId: 't-1', userId: 'u-1', provider: 'openai', scope: 'team' });
    const { sql, params } = render(deletedWhere);
    expect(sql).toContain('"secrets"."user_id" is null');
    expect(sql).toContain('"secrets"."account_id" is null');
    expect(sql).toContain('"secrets"."workspace_id" is null');
    expect(params).not.toContain('anthropic_api_key');
  });
});
