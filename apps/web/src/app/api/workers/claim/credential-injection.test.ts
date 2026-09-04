import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

/**
 * Coverage note — why this file exists.
 *
 * These four blocks lived inside the 2600-line claim route. `route.test.ts`
 * covers `attachServerManagedSecrets` well (24 assertions), but had ZERO
 * coverage for the other three: flipping the codex-backend filter from `!==`
 * to `===` — which hands Codex tokens to Claude tasks and withholds them from
 * Codex ones — kept the whole suite green. Extracting them made them reachable
 * without building a full claim request, so they get real tests here.
 */

const mockSecretsFindMany = mock(async (_args?: any) => [] as any[]);
const mockResolveCodex = mock(async (_scope?: any) => null as any);
const mockResolveClaude = mock(async (_scope?: any) => null as any);
const mockProviderGet = mock(async (_id: string) => null as string | null);

// Predicate stubs: `db` is mocked, so the WHERE clauses are the only place the
// team/workspace scoping of a secrets lookup exists. Turning them into plain
// objects is what makes that scoping assertable — dropping
// `eq(secrets.teamId, …)` or the workspace OR-clause is otherwise invisible.
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  not: (value: any) => ({ value, type: 'not' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings: [...strings], values, type: 'sql' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  secrets: {
    id: 'id', teamId: 'teamId', accountId: 'accountId', workspaceId: 'workspaceId',
    purpose: 'purpose', label: 'label', healthStatus: 'healthStatus', tokenExpiresAt: 'tokenExpiresAt',
  },
}));

mock.module('@buildd/core/db', () => ({
  db: { query: { secrets: { findMany: mockSecretsFindMany } } },
}));
mock.module('@/lib/codex-credential', () => ({
  resolveCodexCredential: mockResolveCodex,
  hasCodexCredential: mock(async () => false),
}));
mock.module('@/lib/claude-credential', () => ({
  resolveClaudeCredential: mockResolveClaude,
}));
mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({ get: mockProviderGet }),
}));

const {
  attachServerManagedSecrets,
  attachCodexCredentials,
  attachClaudeCredentials,
  attachPendingCredentialRefreshes,
} = await import('./credential-injection');

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

/** A claimed worker as the claim route builds it, before enrichment. */
function worker(taskId: string) {
  return { id: `w-${taskId}`, taskId } as any;
}

/** A claim-candidate task row. `backend` and `workspace.teamId` drive routing. */
function task(id: string, backend: string | null, teamId: string | null = 'team-1') {
  return {
    id,
    workspaceId: `ws-${id}`,
    backend,
    workspace: teamId ? { teamId } : undefined,
  } as any;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'test-key';
  mockSecretsFindMany.mockReset();
  mockSecretsFindMany.mockResolvedValue([]);
  mockResolveCodex.mockReset();
  mockResolveCodex.mockResolvedValue(null);
  mockResolveClaude.mockReset();
  mockResolveClaude.mockResolvedValue(null);
  mockProviderGet.mockReset();
  mockProviderGet.mockResolvedValue(null);
});

/** Reads one predicate out of the stubbed WHERE tree by node type + field. */
function predicate(args: any, type: string, field: string) {
  return (args?.where?.args ?? []).find((n: any) => n?.type === type && n.field === field);
}

/** Reads a top-level OR node by the field its branches are about. */
function orBranches(args: any, field: string) {
  return (args?.where?.args ?? [])
    .find((n: any) => n?.type === 'or' && n.args?.some((b: any) => b.field === field))?.args;
}

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

/**
 * `attachServerManagedSecrets` was left to `route.test.ts` when this file was
 * written. It is the block that hands out the team's Anthropic API key / OAuth
 * token, and five mutations in it kept this file green: inverting the codex
 * skip (Anthropic secrets into the Codex CLI), preferring a revoked credential
 * over a healthy one, and dropping the team / account / workspace scoping from
 * the query. Those are the tests below.
 */
describe('attachServerManagedSecrets', () => {
  /** A claimed worker with the hydrated `task` this block reads (not `claimedTasks`). */
  function swWorker(id: string, opts: { backend?: string | null; teamId?: string | null; workspaceId?: string } = {}) {
    const { backend = 'claude', teamId = 'team-1', workspaceId = `ws-${id}` } = opts;
    return {
      id: `w-${id}`,
      taskId: id,
      task: { id, workspaceId, backend, workspace: teamId ? { teamId } : undefined },
    } as any;
  }

  const secretRow = (extra: Record<string, unknown>) => ({
    id: 'sec-1', purpose: 'anthropic_api_key', label: null,
    healthStatus: 'ok', updatedAt: new Date('2026-09-01T00:00:00.000Z'), ...extra,
  });

  it('attaches the decrypted api key and oauth token', async () => {
    mockSecretsFindMany.mockResolvedValue([
      secretRow({ id: 'sec-key', purpose: 'anthropic_api_key' }),
      secretRow({ id: 'sec-oauth', purpose: 'oauth_token' }),
    ]);
    mockProviderGet.mockImplementation(async (id: string) =>
      id === 'sec-key' ? 'sk-ant-key' : id === 'sec-oauth' ? 'oauth-tok' : null);
    const workers = [swWorker('t1')];

    await attachServerManagedSecrets(workers, 'acct-1');

    expect(workers[0].serverApiKey).toBe('sk-ant-key');
    expect(workers[0].serverOauthToken).toBe('oauth-tok');
  });

  // The cross-backend boundary. Codex tasks run the OpenAI CLI; an Anthropic
  // token reaching that subprocess produces spurious Claude auth errors (and is
  // an exposure we don't need to take). Flipping `===` to `!==` here left this
  // file green before this test existed.
  it('does NOT inject Anthropic secrets into a codex-backend task', async () => {
    mockSecretsFindMany.mockResolvedValue([secretRow({ id: 'sec-key' })]);
    mockProviderGet.mockResolvedValue('sk-ant-key');
    const workers = [swWorker('t1', { backend: 'codex' })];

    await attachServerManagedSecrets(workers, 'acct-1');

    expect(workers[0].serverApiKey).toBeUndefined();
    expect(workers[0].serverOauthToken).toBeUndefined();
    expect(mockSecretsFindMany).not.toHaveBeenCalled();
  });

  it('still injects for a task with no backend set (Claude is the default)', async () => {
    mockSecretsFindMany.mockResolvedValue([secretRow({ id: 'sec-key' })]);
    mockProviderGet.mockResolvedValue('sk-ant-key');
    const workers = [swWorker('t1', { backend: null })];

    await attachServerManagedSecrets(workers, 'acct-1');

    expect(workers[0].serverApiKey).toBe('sk-ant-key');
  });

  // Defense in depth: a revoked leftover must never shadow a healthy credential,
  // even when it is the more recently updated row.
  it('prefers a healthy credential over a revoked one, even a newer revoked one', async () => {
    mockSecretsFindMany.mockResolvedValue([
      secretRow({ id: 'sec-revoked', healthStatus: 'revoked', updatedAt: new Date('2026-09-03T00:00:00.000Z') }),
      secretRow({ id: 'sec-active', healthStatus: 'ok', updatedAt: new Date('2026-09-01T00:00:00.000Z') }),
    ]);
    mockProviderGet.mockImplementation(async (id: string) => (id === 'sec-active' ? 'good-key' : 'revoked-key'));
    const workers = [swWorker('t1')];

    await attachServerManagedSecrets(workers, 'acct-1');

    expect(workers[0].serverApiKey).toBe('good-key');
  });

  it('prefers the most recently updated row among healthy credentials', async () => {
    mockSecretsFindMany.mockResolvedValue([
      secretRow({ id: 'sec-old', updatedAt: new Date('2026-09-01T00:00:00.000Z') }),
      secretRow({ id: 'sec-new', updatedAt: new Date('2026-09-03T00:00:00.000Z') }),
    ]);
    mockProviderGet.mockImplementation(async (id: string) => (id === 'sec-new' ? 'new-key' : 'old-key'));
    const workers = [swWorker('t1')];

    await attachServerManagedSecrets(workers, 'acct-1');

    expect(workers[0].serverApiKey).toBe('new-key');
  });

  it('picks per purpose — a revoked api key does not affect the oauth pick', async () => {
    mockSecretsFindMany.mockResolvedValue([
      secretRow({ id: 'sec-key-revoked', purpose: 'anthropic_api_key', healthStatus: 'revoked' }),
      secretRow({ id: 'sec-oauth', purpose: 'oauth_token' }),
    ]);
    mockProviderGet.mockImplementation(async (id: string) =>
      id === 'sec-oauth' ? 'oauth-tok' : 'revoked-key');
    const workers = [swWorker('t1')];

    await attachServerManagedSecrets(workers, 'acct-1');

    expect(workers[0].serverOauthToken).toBe('oauth-tok');
  });

  // Team/account/workspace scoping lives ONLY in this WHERE clause — `db` is
  // mocked, so dropping any of these three filters is otherwise unobservable.
  // The team filter is the cross-team leak guard.
  it('scopes the lookup to the task workspace team, the claiming account and the task workspace', async () => {
    await attachServerManagedSecrets([swWorker('t1', { teamId: 'team-9', workspaceId: 'ws-9' })], 'acct-7');

    const args = mockSecretsFindMany.mock.calls[0]?.[0] as any;
    expect(predicate(args, 'eq', 'teamId')).toEqual({ field: 'teamId', value: 'team-9', type: 'eq' });
    expect(predicate(args, 'inArray', 'purpose').values)
      .toEqual(['anthropic_api_key', 'oauth_token', 'mcp_credential']);
    // Account-scoped rows are visible only to their own account; team-wide rows
    // (accountId NULL) to everyone on the team.
    expect(orBranches(args, 'accountId')).toEqual([
      { field: 'accountId', type: 'isNull' },
      { field: 'accountId', value: 'acct-7', type: 'eq' },
    ]);
    // Same shape for workspace scoping.
    expect(orBranches(args, 'workspaceId')).toEqual([
      { field: 'workspaceId', type: 'isNull' },
      { field: 'workspaceId', value: 'ws-9', type: 'eq' },
    ]);
  });

  it('queries per worker, each with its own workspace team', async () => {
    await attachServerManagedSecrets(
      [swWorker('t1', { teamId: 'team-a', workspaceId: 'ws-a' }), swWorker('t2', { teamId: 'team-b', workspaceId: 'ws-b' })],
      'acct-1',
    );

    expect(predicate(mockSecretsFindMany.mock.calls[0]?.[0], 'eq', 'teamId').value).toBe('team-a');
    expect(predicate(mockSecretsFindMany.mock.calls[1]?.[0], 'eq', 'teamId').value).toBe('team-b');
  });

  it('injects mcp_credential secrets as mcpSecrets keyed by label', async () => {
    mockSecretsFindMany.mockResolvedValue([
      secretRow({ id: 'sec-mcp-1', purpose: 'mcp_credential', label: 'CUE_API_KEY' }),
      secretRow({ id: 'sec-mcp-2', purpose: 'mcp_credential', label: 'CUE_TENANT_ID' }),
    ]);
    mockProviderGet.mockImplementation(async (id: string) =>
      id === 'sec-mcp-1' ? 'key-value' : id === 'sec-mcp-2' ? 'tenant-value' : null);
    const workers = [swWorker('t1')];

    await attachServerManagedSecrets(workers, 'acct-1');

    expect(workers[0].mcpSecrets).toEqual({ CUE_API_KEY: 'key-value', CUE_TENANT_ID: 'tenant-value' });
  });

  it('drops an mcp_credential row with no label or a failed decrypt', async () => {
    mockSecretsFindMany.mockResolvedValue([
      secretRow({ id: 'sec-nolabel', purpose: 'mcp_credential', label: null }),
      secretRow({ id: 'sec-undecryptable', purpose: 'mcp_credential', label: 'BROKEN' }),
      secretRow({ id: 'sec-ok', purpose: 'mcp_credential', label: 'GOOD' }),
    ]);
    mockProviderGet.mockImplementation(async (id: string) => {
      if (id === 'sec-undecryptable') throw new Error('bad ciphertext');
      return id === 'sec-ok' ? 'good-value' : null;
    });
    const workers = [swWorker('t1')];

    await attachServerManagedSecrets(workers, 'acct-1');

    expect(workers[0].mcpSecrets).toEqual({ GOOD: 'good-value' });
  });

  it('attaches nothing when nothing decrypts', async () => {
    mockSecretsFindMany.mockResolvedValue([secretRow({ id: 'sec-key' })]);
    mockProviderGet.mockResolvedValue(null);
    const workers = [swWorker('t1')];

    await attachServerManagedSecrets(workers, 'acct-1');

    expect(workers[0].serverApiKey).toBeUndefined();
    expect(workers[0].mcpSecrets).toBeUndefined();
  });

  it('skips a task whose workspace has no team', async () => {
    await attachServerManagedSecrets([swWorker('t1', { teamId: null })], 'acct-1');
    expect(mockSecretsFindMany).not.toHaveBeenCalled();
  });

  it('is a no-op with no claimed workers, and without ENCRYPTION_KEY', async () => {
    await attachServerManagedSecrets([], 'acct-1');
    expect(mockSecretsFindMany).not.toHaveBeenCalled();

    delete process.env.ENCRYPTION_KEY;
    await attachServerManagedSecrets([swWorker('t1')], 'acct-1');
    expect(mockSecretsFindMany).not.toHaveBeenCalled();
  });

  it('swallows a query failure so the claim still succeeds', async () => {
    mockSecretsFindMany.mockRejectedValue(new Error('db down'));
    const workers = [swWorker('t1')];

    await attachServerManagedSecrets(workers, 'acct-1');

    expect(workers[0].serverApiKey).toBeUndefined();
  });
});

describe('attachCodexCredentials', () => {
  it('attaches an oauth Codex credential to a codex-backend task', async () => {
    const expiresAt = new Date('2026-09-03T12:00:00.000Z');
    mockResolveCodex.mockResolvedValue({
      credentialType: 'oauth',
      accessToken: 'codex-access',
      refreshToken: 'codex-refresh',
      accountId: 'codex-acct',
      idToken: 'codex-id',
      tokenExpiresAt: expiresAt,
    });
    const workers = [worker('t1')];

    await attachCodexCredentials(workers, [task('t1', 'codex')], 'acct-1');

    expect(workers[0].codexCredential).toEqual({
      credentialType: 'oauth',
      accessToken: 'codex-access',
      refreshToken: 'codex-refresh',
      accountId: 'codex-acct',
      idToken: 'codex-id',
      expiresAt: expiresAt,
    });
  });

  it('attaches only apiKey for an api_key credential — no oauth fields leak', async () => {
    mockResolveCodex.mockResolvedValue({
      credentialType: 'api_key',
      apiKey: 'sk-codex',
      accessToken: 'should-not-appear',
      refreshToken: 'should-not-appear',
      tokenExpiresAt: null,
    });
    const workers = [worker('t1')];

    await attachCodexCredentials(workers, [task('t1', 'codex')], 'acct-1');

    expect(workers[0].codexCredential).toEqual({
      credentialType: 'api_key',
      apiKey: 'sk-codex',
      expiresAt: null,
    });
    expect(workers[0].codexCredential.accessToken).toBeUndefined();
    expect(workers[0].codexCredential.refreshToken).toBeUndefined();
  });

  // The token-exposure boundary. A `!==` → `===` slip here ships Codex tokens
  // to every Claude worker, and route.test.ts did not catch it.
  it('does NOT attach a Codex credential to a claude-backend task', async () => {
    mockResolveCodex.mockResolvedValue({ credentialType: 'api_key', apiKey: 'sk-codex', tokenExpiresAt: null });
    const workers = [worker('t1')];

    await attachCodexCredentials(workers, [task('t1', 'claude')], 'acct-1');

    expect(workers[0].codexCredential).toBeUndefined();
    expect(mockResolveCodex).not.toHaveBeenCalled();
  });

  it('resolves with the task workspace and the claiming account', async () => {
    mockResolveCodex.mockResolvedValue(null);

    await attachCodexCredentials([worker('t1')], [task('t1', 'codex', 'team-9')], 'acct-7');

    expect(mockResolveCodex).toHaveBeenCalledWith({
      teamId: 'team-9',
      accountId: 'acct-7',
      workspaceId: 'ws-t1',
    });
  });

  it('skips a task whose workspace has no team', async () => {
    await attachCodexCredentials([worker('t1')], [task('t1', 'codex', null)], 'acct-1');
    expect(mockResolveCodex).not.toHaveBeenCalled();
  });

  it('leaves other workers enriched when one resolve throws', async () => {
    mockResolveCodex.mockImplementation(async (scope: any) => {
      if (scope.workspaceId === 'ws-t1') throw new Error('vault down');
      return { credentialType: 'api_key', apiKey: 'sk-ok', tokenExpiresAt: null };
    });
    const workers = [worker('t1'), worker('t2')];

    await attachCodexCredentials(workers, [task('t1', 'codex'), task('t2', 'codex')], 'acct-1');

    expect(workers[0].codexCredential).toBeUndefined();
    expect(workers[1].codexCredential.apiKey).toBe('sk-ok');
  });

  it('is a no-op without ENCRYPTION_KEY', async () => {
    delete process.env.ENCRYPTION_KEY;
    const workers = [worker('t1')];

    await attachCodexCredentials(workers, [task('t1', 'codex')], 'acct-1');

    expect(workers[0].codexCredential).toBeUndefined();
    expect(mockResolveCodex).not.toHaveBeenCalled();
  });
});

describe('attachClaudeCredentials', () => {
  it('attaches the access token and an ISO expiry for a claude-backend task', async () => {
    mockResolveClaude.mockResolvedValue({
      accessToken: 'claude-access',
      tokenExpiresAt: new Date('2026-09-03T12:00:00.000Z'),
    });
    const workers = [worker('t1')];

    await attachClaudeCredentials(workers, [task('t1', 'claude')]);

    expect(workers[0].claudeAccessToken).toBe('claude-access');
    expect(workers[0].claudeTokenExpiresAt).toBe('2026-09-03T12:00:00.000Z');
  });

  // Workers must never receive a refresh_token: with one in the credentials
  // file the SDK rotates in-session and triggers token-family revocation.
  it('never attaches a refresh token', async () => {
    mockResolveClaude.mockResolvedValue({
      accessToken: 'claude-access',
      refreshToken: 'claude-refresh',
      tokenExpiresAt: null,
    });
    const workers = [worker('t1')];

    await attachClaudeCredentials(workers, [task('t1', 'claude')]);

    expect(JSON.stringify(workers[0])).not.toContain('claude-refresh');
  });

  it('nulls the expiry when the credential has none', async () => {
    mockResolveClaude.mockResolvedValue({ accessToken: 'claude-access', tokenExpiresAt: null });
    const workers = [worker('t1')];

    await attachClaudeCredentials(workers, [task('t1', 'claude')]);

    expect(workers[0].claudeTokenExpiresAt).toBeNull();
  });

  it('does NOT attach a Claude credential to a codex-backend task', async () => {
    mockResolveClaude.mockResolvedValue({ accessToken: 'claude-access', tokenExpiresAt: null });
    const workers = [worker('t1')];

    await attachClaudeCredentials(workers, [task('t1', 'codex')]);

    expect(workers[0].claudeAccessToken).toBeUndefined();
    expect(mockResolveClaude).not.toHaveBeenCalled();
  });

  // Scope was asserted for Codex but not for Claude: dropping `workspaceId`
  // here widens resolution to team-wide and can hand a worker a credential
  // scoped to a different workspace. Nothing caught that.
  it('resolves with the task team and the task workspace', async () => {
    mockResolveClaude.mockResolvedValue(null);

    await attachClaudeCredentials([worker('t1')], [task('t1', 'claude', 'team-9')]);

    expect(mockResolveClaude).toHaveBeenCalledWith({ teamId: 'team-9', workspaceId: 'ws-t1' });
  });

  it('resolves each worker against its own workspace', async () => {
    mockResolveClaude.mockResolvedValue(null);

    await attachClaudeCredentials(
      [worker('t1'), worker('t2')],
      [task('t1', 'claude', 'team-a'), task('t2', 'claude', 'team-b')],
    );

    expect(mockResolveClaude.mock.calls[0][0]).toEqual({ teamId: 'team-a', workspaceId: 'ws-t1' });
    expect(mockResolveClaude.mock.calls[1][0]).toEqual({ teamId: 'team-b', workspaceId: 'ws-t2' });
  });

  it('treats a task with no backend set as Claude', async () => {
    mockResolveClaude.mockResolvedValue({ accessToken: 'claude-access', tokenExpiresAt: null });
    const workers = [worker('t1')];

    await attachClaudeCredentials(workers, [task('t1', null)]);

    expect(workers[0].claudeAccessToken).toBe('claude-access');
  });

  it('swallows a resolve failure so the claim still succeeds', async () => {
    mockResolveClaude.mockRejectedValue(new Error('vault down'));
    const workers = [worker('t1')];

    await attachClaudeCredentials(workers, [task('t1', 'claude')]);

    expect(workers[0].claudeAccessToken).toBeUndefined();
  });

  it('is a no-op without ENCRYPTION_KEY', async () => {
    delete process.env.ENCRYPTION_KEY;
    const workers = [worker('t1')];

    await attachClaudeCredentials(workers, [task('t1', 'claude')]);

    expect(mockResolveClaude).not.toHaveBeenCalled();
  });
});

describe('attachPendingCredentialRefreshes', () => {
  it('maps expiring rows to the runner pre-refresh list', async () => {
    mockSecretsFindMany.mockResolvedValue([
      { id: 'sec-1', purpose: 'claude_credential', tokenExpiresAt: new Date('2026-09-03T10:00:00.000Z') },
      { id: 'sec-2', purpose: 'codex_credential', tokenExpiresAt: new Date('2026-09-03T11:00:00.000Z') },
    ]);
    const workers = [worker('t1')];

    await attachPendingCredentialRefreshes(workers, [task('t1', 'claude')]);

    expect(workers[0].pendingCredentialRefreshes).toEqual([
      { secretId: 'sec-1', purpose: 'claude_credential', expiresAt: '2026-09-03T10:00:00.000Z' },
      { secretId: 'sec-2', purpose: 'codex_credential', expiresAt: '2026-09-03T11:00:00.000Z' },
    ]);
  });

  it('attaches nothing when no credential is near expiry', async () => {
    mockSecretsFindMany.mockResolvedValue([]);
    const workers = [worker('t1')];

    await attachPendingCredentialRefreshes(workers, [task('t1', 'claude')]);

    expect(workers[0].pendingCredentialRefreshes).toBeUndefined();
  });

  // Both backends are pre-refreshed, so this runs regardless of task.backend.
  it('runs for codex-backend tasks too', async () => {
    mockSecretsFindMany.mockResolvedValue([
      { id: 'sec-1', purpose: 'codex_credential', tokenExpiresAt: new Date('2026-09-03T10:00:00.000Z') },
    ]);
    const workers = [worker('t1')];

    await attachPendingCredentialRefreshes(workers, [task('t1', 'codex')]);

    expect(workers[0].pendingCredentialRefreshes).toHaveLength(1);
  });

  it('skips a task whose workspace has no team', async () => {
    await attachPendingCredentialRefreshes([worker('t1')], [task('t1', 'claude', null)]);
    expect(mockSecretsFindMany).not.toHaveBeenCalled();
  });

  // This list is a set of secret IDs the runner may then ask the server to
  // refresh, so its scoping matters as much as the credential injection above.
  // Every filter here is invisible with a mocked `db` unless asserted.
  it('scopes the lookup to the task team, the task workspace, live rows and near expiry', async () => {
    await attachPendingCredentialRefreshes([worker('t1')], [task('t1', 'claude', 'team-9')]);

    const args = mockSecretsFindMany.mock.calls[0]?.[0] as any;
    expect(predicate(args, 'eq', 'teamId')).toEqual({ field: 'teamId', value: 'team-9', type: 'eq' });
    expect(predicate(args, 'inArray', 'purpose').values).toEqual(['claude_credential', 'codex_credential']);
    // A revoked credential is unrecoverable by refresh — never nominate it.
    const notNode = (args.where.args as any[]).find(n => n?.type === 'not');
    expect(notNode.value).toEqual({ field: 'healthStatus', value: 'revoked', type: 'eq' });
    // Only rows that actually expire, and only those expiring within 2 hours.
    expect(predicate(args, 'isNotNull', 'tokenExpiresAt')).toBeDefined();
    const ltNode = predicate(args, 'lt', 'tokenExpiresAt');
    expect(ltNode.value.strings.join('')).toContain("NOW() + INTERVAL '2 hours'");
    // Workspace-scoped rows never cross into another workspace.
    expect(orBranches(args, 'workspaceId')).toEqual([
      { field: 'workspaceId', type: 'isNull' },
      { field: 'workspaceId', value: 'ws-t1', type: 'eq' },
    ]);
  });

  it('swallows a query failure so the claim still succeeds', async () => {
    mockSecretsFindMany.mockRejectedValue(new Error('db down'));
    const workers = [worker('t1')];

    await attachPendingCredentialRefreshes(workers, [task('t1', 'claude')]);

    expect(workers[0].pendingCredentialRefreshes).toBeUndefined();
  });

  it('is a no-op without ENCRYPTION_KEY', async () => {
    delete process.env.ENCRYPTION_KEY;

    await attachPendingCredentialRefreshes([worker('t1')], [task('t1', 'claude')]);

    expect(mockSecretsFindMany).not.toHaveBeenCalled();
  });
});
