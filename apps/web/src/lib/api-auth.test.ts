import { describe, it, expect, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { createHash } from 'crypto';
import { createFakeRedis } from './caller-cache.fixtures';

// Mock database
const mockTaskScopeLookup = mock(() => Promise.resolve({workspaceId: "ws-other"}) as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockTeamMembersFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);

// Redis: an in-memory stand-in, so the caller cache (lib/caller-cache.ts) runs for real.
const fakeRedis = createFakeRedis();

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
      tasks: {findFirst: mockTaskScopeLookup},
      teamMembers: { findFirst: mockTeamMembersFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ type: 'and', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'taskId' },
  accounts: { apiKey: 'apiKey', id: 'id', teamId: 'teamId', type: 'type' },
  teamMembers: { userId: 'userId', teamId: 'teamId' },
  workspaces: { id: 'id', teamId: 'teamId' },
}));

mock.module('./redis', () => fakeRedis.module);

import * as tokensModule from './oauth/tokens';
import {
  hashApiKey,
  extractApiKeyPrefix,
  authenticateApiKey,
  invalidateAccountCache,
  invalidateAccountCacheByHash,
  clearAccountCache,
} from './api-auth';
import { clearCallerCache, callerDep } from './caller-cache';

// Spy on verifyAccessTokenAnyAudience so spyVerifyJwt.mockRestore() properly unwinds it
// after this file, preventing pollution into tokens.test.ts.
// (mock.module + mock.restore() does NOT restore module mocks — spyOn does.)
const spyVerifyJwt = spyOn(tokensModule, 'verifyAccessTokenAnyAudience');

describe('hashApiKey', () => {
  it('returns SHA-256 hex hash of the input', () => {
    const key = 'bld_test123';
    const expected = createHash('sha256').update(key).digest('hex');
    expect(hashApiKey(key)).toBe(expected);
  });

  it('returns different hashes for different keys', () => {
    const hash1 = hashApiKey('bld_key1');
    const hash2 = hashApiKey('bld_key2');
    expect(hash1).not.toBe(hash2);
  });

  it('returns consistent hash for same key', () => {
    const key = 'bld_consistent';
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it('returns 64-character hex string', () => {
    const hash = hashApiKey('bld_any_key');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('extractApiKeyPrefix', () => {
  it('returns first 12 characters of the key', () => {
    const key = 'bld_abc12345xyz789';
    expect(extractApiKeyPrefix(key)).toBe('bld_abc12345');
  });

  it('returns full key if shorter than 12 chars', () => {
    const key = 'short';
    expect(extractApiKeyPrefix(key)).toBe('short');
  });

  it('returns exactly 12 chars for longer keys', () => {
    const key = 'bld_' + 'a'.repeat(64);
    expect(extractApiKeyPrefix(key)).toHaveLength(12);
  });
});

describe('authenticateApiKey', () => {
  beforeEach(() => {
    mockAccountsFindFirst.mockReset();
    mockTeamMembersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    spyVerifyJwt.mockReset();
    fakeRedis.reset();
    mockTeamMembersFindFirst.mockResolvedValue(null);
    mockWorkspacesFindFirst.mockResolvedValue(null);
    spyVerifyJwt.mockResolvedValue(null);
    clearAccountCache();
  });

  it('returns null when apiKey is null', async () => {
    const result = await authenticateApiKey(null);
    expect(result).toBeNull();
    expect(mockAccountsFindFirst).not.toHaveBeenCalled();
  });

  it('returns null when apiKey is empty string', async () => {
    const result = await authenticateApiKey('');
    expect(result).toBeNull();
  });

  it('returns account when key matches', async () => {
    const mockAccount = { id: 'account-123', name: 'Test Account', hostRunner: false, managedRunner: false };
    mockAccountsFindFirst.mockResolvedValue(mockAccount);

    const result = await authenticateApiKey('bld_valid_key');
    expect(result).toEqual(mockAccount);
    expect(mockAccountsFindFirst).toHaveBeenCalled();
  });

  it('returns null when no account matches the hashed key', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);

    const result = await authenticateApiKey('bld_invalid_key');
    expect(result).toBeNull();
  });

  it('returns null when account is undefined', async () => {
    mockAccountsFindFirst.mockResolvedValue(undefined);

    const result = await authenticateApiKey('bld_unknown');
    expect(result).toBeNull();
  });

  it('hashes the key before querying', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);

    await authenticateApiKey('bld_test_key');

    // The mock should have been called with eq() containing the hashed key
    expect(mockAccountsFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.anything(),
      })
    );
  });

  describe('caching', () => {
    it('serves subsequent calls from the cache (no additional DB query)', async () => {
      const mockAccount = { id: 'account-123', name: 'Test Account', hostRunner: false, managedRunner: false };
      mockAccountsFindFirst.mockResolvedValue(mockAccount);

      for (let i = 0; i < 100; i++) expect(await authenticateApiKey('bld_cached_key')).toEqual(mockAccount);
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(1);
    });

    it('keeps an unknown key refused in process only', async () => {
      mockAccountsFindFirst.mockResolvedValue(null);

      await authenticateApiKey('bld_bad_key');
      await authenticateApiKey('bld_bad_key');

      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(1);
      expect([...fakeRedis.store.keys()].some((k) => k.startsWith('buildd:caller:'))).toBe(false);
    });

    it('stores the account in Redis for at most 60 s, shared by every instance', async () => {
      mockAccountsFindFirst.mockResolvedValue({ id: 'db-acct', name: 'DB Account', hostRunner: false, managedRunner: false });
      await authenticateApiKey('bld_db_key');
      const key = `buildd:caller:key:${hashApiKey('bld_db_key')}`;
      expect(fakeRedis.store.has(key)).toBe(true);
      expect(fakeRedis.ttls.get(key)).toBeLessThanOrEqual(60);
    });

    it('different keys get separate cache entries', async () => {
      const account1 = { id: 'acct-1', name: 'Account 1', hostRunner: false, managedRunner: false };
      const account2 = { id: 'acct-2', name: 'Account 2', hostRunner: false, managedRunner: false };
      mockAccountsFindFirst.mockResolvedValueOnce(account1);
      mockAccountsFindFirst.mockResolvedValueOnce(account2);

      expect(await authenticateApiKey('bld_key_1')).toEqual(account1);
      expect(await authenticateApiKey('bld_key_2')).toEqual(account2);
      expect(await authenticateApiKey('bld_key_1')).toEqual(account1);
      expect(await authenticateApiKey('bld_key_2')).toEqual(account2);
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2);
    });

    it('reads the DB on every call when Redis is down (fails open to the DB)', async () => {
      fakeRedis.state.down = true;
      mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', hostRunner: false, managedRunner: false });
      await authenticateApiKey('bld_key');
      await authenticateApiKey('bld_key');
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe('cache invalidation', () => {
    it('invalidateAccountCache: the next call re-reads the account', async () => {
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', name: 'Test Account', hostRunner: false, managedRunner: false });
      await authenticateApiKey('bld_key');
      await invalidateAccountCache('account-123');
      await authenticateApiKey('bld_key');
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2);
    });

    it('a deleted account stops authenticating on the next call once its hook runs', async () => {
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: hashApiKey('bld_key'), hostRunner: false, managedRunner: false });
      expect(await authenticateApiKey('bld_key')).not.toBeNull();
      mockAccountsFindFirst.mockResolvedValue(null);
      await invalidateAccountCacheByHash(hashApiKey('bld_key'));
      expect(await authenticateApiKey('bld_key')).toBeNull();
    });

    it('invalidateAccountCacheByHash clears the negative cache too', async () => {
      mockAccountsFindFirst.mockResolvedValueOnce(null);
      await authenticateApiKey('bld_new_key');
      await invalidateAccountCacheByHash(hashApiKey('bld_new_key'));

      const mockAccount = { id: 'new-acct', name: 'New Account', hostRunner: false, managedRunner: false };
      mockAccountsFindFirst.mockResolvedValueOnce(mockAccount);
      expect(await authenticateApiKey('bld_new_key')).toEqual(mockAccount);
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2);
    });

    it('clearAccountCache empties the negative cache', async () => {
      mockAccountsFindFirst.mockResolvedValue(null);
      await authenticateApiKey('bld_key_a');
      clearAccountCache();
      await authenticateApiKey('bld_key_a');
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe('OAuth JWT path', () => {
    // A string that matches the looksLikeJwt regex (three base64url segments)
    const JWT_TOKEN = 'eyJhbGc.dGVzdA.c2ln';

    it('returns null when JWT verification fails', async () => {
      spyVerifyJwt.mockResolvedValue(null);
      const result = await authenticateApiKey(JWT_TOKEN);
      expect(result).toBeNull();
    });

    it('returns null when workspace is not found', async () => {
      spyVerifyJwt.mockResolvedValue({ sub: 'user-1', workspace_id: 'ws-1', scope: 'mcp', client_id: 'c_1' });
      mockWorkspacesFindFirst.mockResolvedValue(null);
      const result = await authenticateApiKey(JWT_TOKEN);
      expect(result).toBeNull();
    });

    it('returns null when user is not a member of the workspace team', async () => {
      spyVerifyJwt.mockResolvedValue({ sub: 'user-1', workspace_id: 'ws-1', scope: 'mcp', client_id: 'c_1' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockTeamMembersFindFirst.mockResolvedValue(null);
      const result = await authenticateApiKey(JWT_TOKEN);
      expect(result).toBeNull();
    });

    it('returns null when no type="user" account exists for workspace team', async () => {
      spyVerifyJwt.mockResolvedValue({ sub: 'user-1', workspace_id: 'ws-1', scope: 'mcp', client_id: 'c_1' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockTeamMembersFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockAccountsFindFirst.mockResolvedValue(null);
      const result = await authenticateApiKey(JWT_TOKEN);
      expect(result).toBeNull();
    });

    // The session's level is the caller's current team role, not a constant:
    // owner|admin act as admin, member acts as worker, and anything else
    // (unknown or missing role) falls to worker — never admin.
    const roleCases: [string | undefined, 'admin' | 'worker'][] = [
      ['owner', 'admin'],
      ['admin', 'admin'],
      ['member', 'worker'],
      ['some-future-role', 'worker'],
      [undefined, 'worker'],
    ];
    for (const [role, level] of roleCases) {
      it(`team role ${role ?? '(missing)'} → level ${level}`, async () => {
        spyVerifyJwt.mockResolvedValue({ sub: 'user-1', workspace_id: 'ws-1', scope: 'mcp', client_id: 'c_1' });
        mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
        mockTeamMembersFindFirst.mockResolvedValue(role === undefined ? { teamId: 'team-1' } : { teamId: 'team-1', role });
        const mockAccount = { id: 'acct-1', type: 'user', level: 'admin', teamId: 'team-1', name: 'My Account' };
        mockAccountsFindFirst.mockResolvedValue(mockAccount);

        const result = await authenticateApiKey(JWT_TOKEN);
        // sessionUserId: the person behind the session (the account is team-shared).
        expect(result).toMatchObject({ ...mockAccount, level, scopes: null, sessionUserId: 'user-1' });
      });
    }

    it('a stored account level never raises a member above worker', async () => {
      spyVerifyJwt.mockResolvedValue({ sub: 'user-1', workspace_id: 'ws-1', scope: 'mcp', client_id: 'c_1' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockTeamMembersFindFirst.mockResolvedValue({ teamId: 'team-1', role: 'member' });
      mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', type: 'user', level: 'admin', teamId: 'team-1' });

      const result = await authenticateApiKey(JWT_TOKEN);
      expect(result?.level).toBe('worker');
    });

    it('reads the membership role from team_members', async () => {
      spyVerifyJwt.mockResolvedValue({ sub: 'user-1', workspace_id: 'ws-1', scope: 'mcp', client_id: 'c_1' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockTeamMembersFindFirst.mockResolvedValue({ teamId: 'team-1', role: 'admin' });
      mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', type: 'user', level: 'worker', teamId: 'team-1' });

      await authenticateApiKey(JWT_TOKEN);
      const arg = (mockTeamMembersFindFirst.mock.calls[0] as any[])[0];
      expect(arg.columns?.role).toBe(true);
    });

    describe('role and membership changes', () => {
      const legacy = { sub: 'user-1', workspace_id: 'ws-1', scope: 'mcp', client_id: 'c_1' };
      const sessionAccount = { id: 'acct-1', type: 'user', level: 'worker', teamId: 'team-1', apiKey: 'h1', hostRunner: false, managedRunner: false };

      it('a removed member stops authenticating on the next call once the membership hook runs', async () => {
        spyVerifyJwt.mockResolvedValue(legacy);
        mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
        mockTeamMembersFindFirst.mockResolvedValue({ teamId: 'team-1', role: 'admin' });
        mockAccountsFindFirst.mockResolvedValue(sessionAccount);

        expect((await authenticateApiKey(JWT_TOKEN))?.level).toBe('admin');
        mockTeamMembersFindFirst.mockResolvedValue(null);
        await clearCallerCache(callerDep.user('user-1'));
        expect(await authenticateApiKey(JWT_TOKEN)).toBeNull();
      });

      it('a downgraded admin acts as worker on the next call once the role hook runs', async () => {
        spyVerifyJwt.mockResolvedValue(legacy);
        mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
        mockTeamMembersFindFirst.mockResolvedValue({ teamId: 'team-1', role: 'admin' });
        mockAccountsFindFirst.mockResolvedValue(sessionAccount);

        expect((await authenticateApiKey(JWT_TOKEN))?.level).toBe('admin');
        mockTeamMembersFindFirst.mockResolvedValue({ teamId: 'team-1', role: 'member' });
        await clearCallerCache(callerDep.user('user-1'));
        expect((await authenticateApiKey(JWT_TOKEN))?.level).toBe('worker');
      });

      it('writes OAuth entries with a TTL of at most 60 s, so a change with no hook lands within it', async () => {
        spyVerifyJwt.mockResolvedValue(legacy);
        mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
        mockTeamMembersFindFirst.mockResolvedValue({ teamId: 'team-1', role: 'admin' });
        mockAccountsFindFirst.mockResolvedValue(sessionAccount);

        await authenticateApiKey(JWT_TOKEN);
        const ttls = [...fakeRedis.ttls.entries()].filter(([k]) => k.startsWith('buildd:caller:')).map(([, t]) => t);
        expect(ttls.length).toBe(2);
        for (const t of ttls) expect(t).toBeLessThanOrEqual(60);
      });

      it('a refused session is not kept: membership added later authenticates on the next call', async () => {
        spyVerifyJwt.mockResolvedValue(legacy);
        mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
        mockTeamMembersFindFirst.mockResolvedValue(null);
        mockAccountsFindFirst.mockResolvedValue(sessionAccount);
        expect(await authenticateApiKey(JWT_TOKEN)).toBeNull();

        mockTeamMembersFindFirst.mockResolvedValue({ teamId: 'team-1', role: 'member' });
        expect((await authenticateApiKey(JWT_TOKEN))?.level).toBe('worker');
      });
    });

    it('verifies the JWT on every call but resolves the caller from the DB only once', async () => {
      spyVerifyJwt.mockResolvedValue({ sub: 'user-1', workspace_id: 'ws-1', scope: 'mcp', client_id: 'c_1' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockTeamMembersFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', type: 'user', level: 'worker', teamId: 'team-1', apiKey: 'h1', hostRunner: false, managedRunner: false });

      for (let i = 0; i < 100; i++) expect(await authenticateApiKey(JWT_TOKEN)).not.toBeNull();

      expect(spyVerifyJwt).toHaveBeenCalledTimes(100);
      expect(mockWorkspacesFindFirst).toHaveBeenCalledTimes(1);
      expect(mockTeamMembersFindFirst).toHaveBeenCalledTimes(1);
      expect(mockAccountsFindFirst).toHaveBeenCalledTimes(1);
    });

    it('keeps a token whose signature fails refused without re-verifying', async () => {
      spyVerifyJwt.mockResolvedValue(null);
      await authenticateApiKey(JWT_TOKEN);
      await authenticateApiKey(JWT_TOKEN);
      expect(spyVerifyJwt).toHaveBeenCalledTimes(1);
    });

    it('resolves the team via workspace_id from JWT claims, not teamMembers alone', async () => {
      spyVerifyJwt.mockResolvedValue({ sub: 'user-1', workspace_id: 'ws-targeted', scope: 'mcp', client_id: 'c_1' });
      mockWorkspacesFindFirst.mockResolvedValue(null); // workspace not found → should bail

      const result = await authenticateApiKey(JWT_TOKEN);
      expect(result).toBeNull();
      // The workspace lookup must have been called
      expect(mockWorkspacesFindFirst).toHaveBeenCalledTimes(1);
    });
  });
});

// Restore the spy so verifyAccessTokenAnyAudience is real again in subsequent test files.
// spyOn + mockRestore() properly unwinds; mock.restore() does not restore mock.module() overrides.
afterAll(() => spyVerifyJwt.mockRestore());

describe('scoped token authentication', () => {
  beforeEach(() => { clearAccountCache(); fakeRedis.reset(); });
  it('rejects expired keys even from the positive cache', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'expired', scopes: ['tasks:read'], expiresAt: new Date(0) });
    expect(await authenticateApiKey('bld_expired', new Request('http://localhost/api/tasks'))).toBeNull();
  });
  it('refuses a read-only token on writes and allows task reads', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'reader', scopes: ['tasks:read'], expiresAt: null });
    expect(await authenticateApiKey('bld_reader', new Request('http://localhost/api/tasks', {method:'POST'}))).toBeNull();
    expect(await authenticateApiKey('bld_reader', new Request('http://localhost/api/tasks'))).not.toBeNull();
  });
  it('keeps legacy tokens working without explicit scopes', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'legacy', scopes: null });
    expect(await authenticateApiKey('bld_legacy')).not.toBeNull();
  });
});

it('scoped tokens cannot reach a task outside their workspace restriction', async () => {
  clearAccountCache(); fakeRedis.reset();
  mockAccountsFindFirst.mockResolvedValue({id:'limited', scopes:['tasks:read'],workspaceIds:['ws-selected']});
  mockTaskScopeLookup.mockResolvedValue({workspaceId:'ws-other'});
  expect(await authenticateApiKey('bld_limited', new Request('http://localhost/api/tasks/00000000-0000-0000-0000-000000000001'))).toBeNull();
  mockTaskScopeLookup.mockResolvedValue({workspaceId:'ws-selected'});
  expect(await authenticateApiKey('bld_limited', new Request('http://localhost/api/tasks/00000000-0000-0000-0000-000000000001'))).not.toBeNull();
});

it('workspace-restricted tokens must name a workspace when creating team-level work', async () => {
  clearAccountCache(); fakeRedis.reset();
  mockAccountsFindFirst.mockResolvedValue({ id: 'limited-admin', scopes: ['missions:admin'], workspaceIds: ['ws-selected'] });
  const post = (path: string, body: object) => new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const path of ['/api/missions', '/api/initiatives']) {
    expect(await authenticateApiKey('bld_limited_admin', post(path, { title: 'Team-wide' }))).toBeNull();
    expect(await authenticateApiKey('bld_limited_admin', post(path, { title: 'Scoped', workspaceId: 'ws-selected' }))).not.toBeNull();
  }
});

describe('authenticateApiKey — per-task tokens', () => {
  it('never resolves a per-task token to an account, even one whose hash matches a row', async () => {
    clearAccountCache();
    fakeRedis.reset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker', hostRunner: true });
    expect(await authenticateApiKey('bldt_payload.sig')).toBeNull();
    expect(mockAccountsFindFirst).not.toHaveBeenCalled();
  });

  it('never resolves a person presence token to an account: only the presence routes accept one', async () => {
    clearAccountCache();
    fakeRedis.reset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'admin', hostRunner: true });
    expect(await authenticateApiKey('bldp_payload.sig')).toBeNull();
    expect(mockAccountsFindFirst).not.toHaveBeenCalled();
  });
});

describe('authenticateApiKey — cached records from before a column auth reads', () => {
  const seed = (key: string, v: unknown) =>
    fakeRedis.store.set(`buildd:caller:key:${hashApiKey(key)}`, { v, d: [], s: [] });

  it('re-fetches a cached record that has no hostRunner field instead of serving it', async () => {
    clearAccountCache();
    fakeRedis.reset();
    mockAccountsFindFirst.mockReset();
    seed('bld_pre_column_record', { id: 'acct-1', teamId: 'team-1', level: 'worker' });
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker', hostRunner: true, managedRunner: false });

    expect((await authenticateApiKey('bld_pre_column_record'))?.hostRunner).toBe(true);
    expect((await authenticateApiKey('bld_pre_column_record'))?.hostRunner).toBe(true);
    // Rewritten with the field, and served from the cache afterwards.
    expect(mockAccountsFindFirst).toHaveBeenCalledTimes(1);
  });

  it('re-fetches a record from before accounts.managedRunner: a managed key must not skip its plan limits', async () => {
    clearAccountCache();
    fakeRedis.reset();
    mockAccountsFindFirst.mockReset();
    seed('bld_pre_managed_column', { id: 'acct-m', teamId: 'team-1', level: 'worker', hostRunner: false });
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-m', teamId: 'team-1', level: 'worker', hostRunner: false, managedRunner: true });
    expect((await authenticateApiKey('bld_pre_managed_column'))?.managedRunner).toBe(true);
    expect(mockAccountsFindFirst).toHaveBeenCalledTimes(1);
  });

  it('serves a cached record that has the fields', async () => {
    clearAccountCache();
    fakeRedis.reset();
    mockAccountsFindFirst.mockReset();
    seed('bld_current_record', { id: 'acct-1', teamId: 'team-1', level: 'worker', hostRunner: false, managedRunner: false });
    expect((await authenticateApiKey('bld_current_record'))?.hostRunner).toBe(false);
    expect(mockAccountsFindFirst).not.toHaveBeenCalled();
  });
});
