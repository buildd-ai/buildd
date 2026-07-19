import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── mocks (before any imports that trigger module loading) ────────────────────

const mockUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
  })),
}));
const mockDelete = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockInsert = mock(() => ({ values: mock(() => Promise.resolve()) }));
const mockFindFirst = mock(() => Promise.resolve(null as any));
const mockFindMany = mock(() => Promise.resolve([] as any[]));

mock.module('@buildd/core/db', () => ({
  db: {
    update: mockUpdate,
    delete: mockDelete,
    insert: mockInsert,
    query: {
      secrets: { findFirst: mockFindFirst, findMany: mockFindMany },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  secrets: {
    id: 'id', teamId: 'team_id', accountId: 'account_id', workspaceId: 'workspace_id',
    purpose: 'purpose', encryptedValue: 'encrypted_value',
    tokenExpiresAt: 'token_expires_at', lastRefreshedAt: 'last_refreshed_at',
    lastVerifiedAt: 'last_verified_at', lastVerificationError: 'last_verification_error',
    updatedAt: 'updated_at',
  },
}));

mock.module('@buildd/core/secrets', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));

mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ __eq: { f, v } }),
  and: (...c: any[]) => ({ __and: c }),
  or: (...c: any[]) => ({ __or: c }),
  isNull: (f: any) => ({ __isNull: f }),
  lt: (f: any, v: any) => ({ __lt: { f, v } }),
  sql: Object.assign((s: any) => ({ __sql: s }), {
    NOW: {},
    raw: (s: string) => ({ __raw: s }),
  }),
}));

// ── import under test (after mocks) ──────────────────────────────────────────

import {
  normalizeClaudeCredentialsJson,
  storeClaudeCredential,
  resolveClaudeCredential,
  getClaudeStatus,
  deleteClaudeCredential,
  refreshClaudeCredential,
} from './claude-credential';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeBlob(access_token = 'at', refresh_token = 'rt') {
  return `enc:${JSON.stringify({ access_token, refresh_token })}`;
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    encryptedValue: makeBlob(),
    workspaceId: null,
    tokenExpiresAt: null,
    lastRefreshedAt: new Date(),
    lastVerifiedAt: null,
    lastVerificationError: null,
    ...overrides,
  };
}

// ── normalizeClaudeCredentialsJson ────────────────────────────────────────────

describe('normalizeClaudeCredentialsJson', () => {
  it('accepts valid credentials JSON', () => {
    const result = normalizeClaudeCredentialsJson({
      type: 'oauth_token',
      access_token: 'at_abc',
      refresh_token: 'rt_xyz',
      expires_at: 1700000000,
      version: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.access_token).toBe('at_abc');
      expect(result.value.refresh_token).toBe('rt_xyz');
      expect(result.value.expires_at).toBe(1700000000);
    }
  });

  it('rejects non-object input', () => {
    expect(normalizeClaudeCredentialsJson('string').ok).toBe(false);
    expect(normalizeClaudeCredentialsJson(null).ok).toBe(false);
  });

  it('rejects missing access_token', () => {
    const result = normalizeClaudeCredentialsJson({ refresh_token: 'rt' });
    expect(result.ok).toBe(false);
  });

  it('rejects missing refresh_token', () => {
    const result = normalizeClaudeCredentialsJson({ access_token: 'at' });
    expect(result.ok).toBe(false);
  });

  it('accepts credentials without expires_at', () => {
    const result = normalizeClaudeCredentialsJson({ access_token: 'at', refresh_token: 'rt' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.expires_at).toBeUndefined();
  });
});

// ── storeClaudeCredential ─────────────────────────────────────────────────────

describe('storeClaudeCredential', () => {
  beforeEach(() => {
    mockDelete.mockReset();
    mockInsert.mockReset();
    mockDelete.mockReturnValue({ where: mock(() => Promise.resolve()) });
    mockInsert.mockReturnValue({ values: mock(() => Promise.resolve()) });
  });

  it('deletes then inserts (replace semantics)', async () => {
    await storeClaudeCredential({ teamId: 'team-1' }, {
      access_token: 'at', refresh_token: 'rt',
    });
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('stores team-wide by default (workspaceId = null)', async () => {
    const insertValues = mock(() => Promise.resolve());
    mockInsert.mockReturnValue({ values: insertValues });
    await storeClaudeCredential({ teamId: 'team-1' }, {
      access_token: 'at', refresh_token: 'rt',
    });
    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.teamId).toBe('team-1');
    expect(row.workspaceId).toBeNull();
    expect(row.accountId).toBeNull();
    expect(row.purpose).toBe('claude_credential');
  });

  it('sets tokenExpiresAt from expires_at (epoch seconds)', async () => {
    const insertValues = mock(() => Promise.resolve());
    mockInsert.mockReturnValue({ values: insertValues });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await storeClaudeCredential({ teamId: 'team-1' }, {
      access_token: 'at', refresh_token: 'rt', expires_at: expiresAt,
    });
    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.tokenExpiresAt).toBeInstanceOf(Date);
    const diff = Math.abs((row.tokenExpiresAt as Date).getTime() / 1000 - expiresAt);
    expect(diff).toBeLessThan(2);
  });

  it('stores workspace-scoped when workspaceId provided', async () => {
    const insertValues = mock(() => Promise.resolve());
    mockInsert.mockReturnValue({ values: insertValues });
    await storeClaudeCredential({ teamId: 'team-1', workspaceId: 'ws-1' }, {
      access_token: 'at', refresh_token: 'rt',
    });
    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.workspaceId).toBe('ws-1');
  });

  it('stores encrypted blob (access_token + refresh_token, no account_id)', async () => {
    const insertValues = mock(() => Promise.resolve());
    mockInsert.mockReturnValue({ values: insertValues });
    await storeClaudeCredential({ teamId: 'team-1' }, {
      access_token: 'my-at', refresh_token: 'my-rt',
    });
    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    // decrypt mock: enc:${json} → json
    const decoded = JSON.parse((row.encryptedValue as string).replace(/^enc:/, ''));
    expect(decoded.access_token).toBe('my-at');
    expect(decoded.refresh_token).toBe('my-rt');
    expect(decoded.account_id).toBeUndefined();
  });
});

// ── resolveClaudeCredential ───────────────────────────────────────────────────

describe('resolveClaudeCredential', () => {
  beforeEach(() => mockFindMany.mockReset());

  it('returns null when no credential exists', async () => {
    mockFindMany.mockResolvedValue([]);
    const result = await resolveClaudeCredential({ teamId: 'team-1' });
    expect(result).toBeNull();
  });

  it('returns credential with access_token', async () => {
    mockFindMany.mockResolvedValue([makeRow()]);
    const result = await resolveClaudeCredential({ teamId: 'team-1' });
    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe('at');
  });

  it('prefers workspace-scoped over team-wide', async () => {
    mockFindMany.mockResolvedValue([
      makeRow({ encryptedValue: makeBlob('at-team'), workspaceId: null }),
      makeRow({ encryptedValue: makeBlob('at-ws'), workspaceId: 'ws-1' }),
    ]);
    const result = await resolveClaudeCredential({ teamId: 'team-1', workspaceId: 'ws-1' });
    expect(result?.accessToken).toBe('at-ws');
  });

  it('returns team-wide when no workspace-specific row', async () => {
    mockFindMany.mockResolvedValue([
      makeRow({ encryptedValue: makeBlob('at-team'), workspaceId: null }),
    ]);
    const result = await resolveClaudeCredential({ teamId: 'team-1', workspaceId: 'ws-1' });
    expect(result?.accessToken).toBe('at-team');
  });
});

// ── getClaudeStatus ───────────────────────────────────────────────────────────

describe('getClaudeStatus', () => {
  beforeEach(() => mockFindFirst.mockReset());

  it('returns connected: false when no credential', async () => {
    mockFindFirst.mockResolvedValue(null);
    const status = await getClaudeStatus({ teamId: 'team-1' });
    expect(status.connected).toBe(false);
    expect(status.scope).toBeNull();
  });

  it('returns connected: true when credential exists', async () => {
    mockFindFirst.mockResolvedValue(makeRow());
    const status = await getClaudeStatus({ teamId: 'team-1' });
    expect(status.connected).toBe(true);
    expect(status.expired).toBe(false);
  });

  it('returns expired: true for past tokenExpiresAt', async () => {
    mockFindFirst.mockResolvedValue(makeRow({ tokenExpiresAt: new Date(Date.now() - 1000) }));
    const status = await getClaudeStatus({ teamId: 'team-1' });
    expect(status.expired).toBe(true);
  });

  it('returns scope: workspace when workspaceId set', async () => {
    mockFindFirst.mockResolvedValue(makeRow({ workspaceId: 'ws-1' }));
    const status = await getClaudeStatus({ teamId: 'team-1', workspaceId: 'ws-1' });
    expect(status.scope).toBe('workspace');
  });

  it('returns scope: team when workspaceId is null', async () => {
    mockFindFirst.mockResolvedValue(makeRow({ workspaceId: null }));
    const status = await getClaudeStatus({ teamId: 'team-1' });
    expect(status.scope).toBe('team');
  });
});

// ── refreshClaudeCredential ───────────────────────────────────────────────────

describe('refreshClaudeCredential', () => {
  beforeEach(() => {
    mockUpdate.mockReset();
    mockFindFirst.mockReset();
  });

  it('returns locked when lock not acquired', async () => {
    const returningMock = mock(() => Promise.resolve([]));
    mockUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({ returning: returningMock })),
      })),
    });
    mockFindFirst.mockResolvedValue({ id: 'secret-1' });
    const result = await refreshClaudeCredential('secret-1');
    expect(result).toBe('locked');
  });

  it('returns no_credential when secret does not exist', async () => {
    const returningMock = mock(() => Promise.resolve([]));
    mockUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({ returning: returningMock })),
      })),
    });
    mockFindFirst.mockResolvedValue(null);
    const result = await refreshClaudeCredential('nonexistent');
    expect(result).toBe('no_credential');
  });

  it('returns no_credential when blob has no refresh_token', async () => {
    const encryptedValue = `enc:${JSON.stringify({ access_token: 'at' })}`;
    const returningMock = mock(() => Promise.resolve([{ id: 'secret-1', encryptedValue, purpose: 'claude_credential' }]));
    mockUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({ returning: returningMock })),
      })),
    });
    const result = await refreshClaudeCredential('secret-1');
    expect(result).toBe('no_credential');
  });

  it('returns refreshed and persists new tokens on success', async () => {
    const encryptedValue = makeBlob('old-at', 'old-rt');
    const updatedBlob = { access_token: 'new-at', refresh_token: 'new-rt' };
    const returningMock = mock(() => Promise.resolve([{ id: 'secret-1', encryptedValue, purpose: 'claude_credential' }]));
    const secondReturning = mock(() => Promise.resolve([{ id: 'secret-1' }]));
    let callCount = 0;
    mockUpdate.mockImplementation(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: callCount++ === 0 ? returningMock : secondReturning,
        })),
      })),
    }));

    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    })) as any;

    const result = await refreshClaudeCredential('secret-1');
    expect(result).toBe('refreshed');
  });

  it('returns error on network failure', async () => {
    const encryptedValue = makeBlob();
    const returningMock = mock(() => Promise.resolve([{ id: 'secret-1', encryptedValue, purpose: 'claude_credential' }]));
    mockUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({ returning: returningMock })),
      })),
    });

    global.fetch = mock(async () => { throw new Error('Network error'); }) as any;

    const result = await refreshClaudeCredential('secret-1');
    expect(result).toBe('error');
  });
});
