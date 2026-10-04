import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── mock setup (before any imports that trigger module loading) ───────────────

const mockDbFindMany = mock(() => Promise.resolve([] as any[]));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      secrets: { findMany: mockDbFindMany },
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
    healthStatus: 'health_status',
  },
}));

mock.module('@buildd/core/secrets', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ __eq: true, field, value }),
  and: (...conds: any[]) => ({ __and: true, conds }),
  or: (...conds: any[]) => ({ __or: true, conds }),
  isNull: (field: any) => ({ __isNull: true, field }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ __sql: true, strings, values }),
}));

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { hasOpenAiApiKey, resolveOpenAiApiKey } from './openai-credential';

function row(extra: Record<string, unknown>) {
  return {
    id: 'sec-1',
    encryptedValue: 'enc:sk-team-key',
    accountId: null,
    workspaceId: null,
    healthStatus: 'healthy',
    ...extra,
  };
}

beforeEach(() => {
  mockDbFindMany.mockReset();
  mockDbFindMany.mockResolvedValue([]);
});

describe('resolveOpenAiApiKey', () => {
  it('returns null when nothing is stored', async () => {
    expect(await resolveOpenAiApiKey({ teamId: 'team-1' })).toBeNull();
  });

  it('decrypts the team-wide key', async () => {
    mockDbFindMany.mockResolvedValue([row({})]);
    const cred = await resolveOpenAiApiKey({ teamId: 'team-1' });
    expect(cred).toEqual({ apiKey: 'sk-team-key', secretId: 'sec-1' });
  });

  it('prefers a workspace-scoped key over team-wide', async () => {
    mockDbFindMany.mockResolvedValue([
      row({ id: 'sec-team', encryptedValue: 'enc:sk-team' }),
      row({ id: 'sec-ws', encryptedValue: 'enc:sk-ws', workspaceId: 'ws-1' }),
    ]);
    const cred = await resolveOpenAiApiKey({ teamId: 'team-1', workspaceId: 'ws-1' });
    expect(cred?.apiKey).toBe('sk-ws');
  });

  it('prefers an account-scoped key over team-wide, but not over workspace', async () => {
    mockDbFindMany.mockResolvedValue([
      row({ id: 'sec-team', encryptedValue: 'enc:sk-team' }),
      row({ id: 'sec-acct', encryptedValue: 'enc:sk-acct', accountId: 'acct-1' }),
    ]);
    const cred = await resolveOpenAiApiKey({ teamId: 'team-1', accountId: 'acct-1', workspaceId: 'ws-1' });
    expect(cred?.apiKey).toBe('sk-acct');
  });

  it('skips a revoked row', async () => {
    mockDbFindMany.mockResolvedValue([row({ healthStatus: 'revoked' })]);
    expect(await resolveOpenAiApiKey({ teamId: 'team-1' })).toBeNull();
  });

  it('returns null when the decrypted value is empty', async () => {
    mockDbFindMany.mockResolvedValue([row({ encryptedValue: '' })]);
    expect(await resolveOpenAiApiKey({ teamId: 'team-1' })).toBeNull();
  });
});

describe('hasOpenAiApiKey', () => {
  it('is false with nothing stored, true once a row exists', async () => {
    expect(await hasOpenAiApiKey({ teamId: 'team-1' })).toBe(false);
    mockDbFindMany.mockResolvedValue([row({})]);
    expect(await hasOpenAiApiKey({ teamId: 'team-1' })).toBe(true);
  });

  it('ignores a revoked-only row', async () => {
    mockDbFindMany.mockResolvedValue([row({ healthStatus: 'revoked' })]);
    expect(await hasOpenAiApiKey({ teamId: 'team-1' })).toBe(false);
  });

  it("'any' ignores account scoping", async () => {
    await hasOpenAiApiKey({ teamId: 'team-1', accountId: 'any', workspaceId: 'ws-1' });
    const args = mockDbFindMany.mock.calls[0]?.[0] as any;
    // No account-scoped OR-branch should be present in the where tree.
    const accountBranch = (args.where.conds as any[]).find((c) => c?.conds?.some?.((b: any) => b?.field === 'account_id'));
    expect(accountBranch).toBeUndefined();
  });
});
