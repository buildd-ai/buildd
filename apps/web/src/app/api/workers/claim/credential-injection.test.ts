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
  getSecretsProvider: () => ({ get: async () => null }),
}));

const {
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
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
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
