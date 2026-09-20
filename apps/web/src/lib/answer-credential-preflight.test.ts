import { describe, it, expect, beforeEach, mock } from 'bun:test';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

/** Rows the mocked `secrets.findFirst` serves, in call order. */
let secretRows: Array<Record<string, unknown> | undefined> = [];
const findFirstCalls: any[] = [];
const mockFindFirst = mock(async (args: any) => {
  findFirstCalls.push(args);
  return secretRows.shift();
});

const mockRefreshClaude = mock(async (_id: string) => 'refreshed' as string);
const mockRefreshCodex = mock(async (_id: string) => 'refreshed' as string);

mock.module('@buildd/core/db', () => ({
  db: { query: { secrets: { findFirst: mockFindFirst } } },
}));

mock.module('@buildd/core/db/schema', () => ({
  secrets: {
    teamId: 'secrets.teamId',
    purpose: 'secrets.purpose',
    workspaceId: 'secrets.workspaceId',
  },
}));

mock.module('drizzle-orm', () => ({
  and: (...c: any[]) => ({ type: 'and', c }),
  eq: (field: any, value: any) => ({ type: 'eq', field, value }),
  isNull: (field: any) => ({ type: 'isNull', field }),
}));

mock.module('./claude-credential', () => ({ refreshClaudeCredential: mockRefreshClaude }));
mock.module('./codex-credential', () => ({ refreshCodexCredential: mockRefreshCodex }));

const { preflightBackendCredential, CREDENTIAL_PREFLIGHT_MARGIN_MS } =
  await import('./answer-credential-preflight');

function healthy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'secret-1',
    tokenExpiresAt: new Date(NOW + 60 * 60 * 1000),
    healthStatus: 'healthy',
    lastFailureMessage: null,
    ...overrides,
  };
}

beforeEach(() => {
  secretRows = [];
  findFirstCalls.length = 0;
  mockFindFirst.mockClear();
  // mockClear does not restore the implementation, and one test replaces it
  // with a thrower — restore it explicitly or every later test inherits that.
  mockFindFirst.mockImplementation(async (args: any) => {
    findFirstCalls.push(args);
    return secretRows.shift();
  });
  mockRefreshClaude.mockClear();
  mockRefreshCodex.mockClear();
  mockRefreshClaude.mockImplementation(async () => 'refreshed');
  mockRefreshCodex.mockImplementation(async () => 'refreshed');
});

const claude = { teamId: 'team-1', workspaceId: 'ws-1', backend: 'claude' as const, now: NOW };

describe('preflightBackendCredential', () => {
  it('reports ok for a healthy, unexpired credential and attempts no refresh', async () => {
    secretRows = [healthy()];
    const result = await preflightBackendCredential(claude);
    expect(result.state).toBe('ok');
    expect(mockRefreshClaude).not.toHaveBeenCalled();
  });

  // AC-AQR-19 — `revoked` is a stronger statement than `unhealthy`, and the
  // route refuses on it rather than degrading (AC-AQR-25), so the flag must be
  // set and not merely implied by the prose.
  it('reports unhealthy AND revoked for a revoked credential, without attempting a refresh', async () => {
    secretRows = [healthy({ healthStatus: 'revoked', lastFailureMessage: 'invalid_grant' })];
    const result = await preflightBackendCredential(claude);
    expect(result.state).toBe('unhealthy');
    expect(result.revoked).toBe(true);
    expect(result.detail).toContain('revoked');
    expect(result.lastFailureMessage).toBe('invalid_grant');
    expect(mockRefreshClaude).not.toHaveBeenCalled();
  });

  // AC-AQR-20 (refresh succeeds)
  it('refreshes an expired credential and reports ok when the refresh lands', async () => {
    secretRows = [
      healthy({ tokenExpiresAt: new Date(NOW - 1000) }),
      healthy({ tokenExpiresAt: new Date(NOW + 60 * 60 * 1000) }),
    ];
    const result = await preflightBackendCredential(claude);
    expect(mockRefreshClaude).toHaveBeenCalledWith('secret-1');
    expect(result.state).toBe('ok');
  });

  // AC-AQR-20 (refresh does not land)
  it('reports unhealthy when the credential is still expired after the refresh', async () => {
    secretRows = [
      healthy({ tokenExpiresAt: new Date(NOW - 1000) }),
      healthy({ tokenExpiresAt: new Date(NOW - 1000) }),
    ];
    const result = await preflightBackendCredential(claude);
    expect(result.state).toBe('unhealthy');
    expect(result.detail).toContain('expired');
    // Recoverable without human action, so NOT revoked — this is the state the
    // route degrades to a cold continuation instead of refusing.
    expect(result.revoked).toBeUndefined();
  });

  it('treats a credential expiring inside the margin as expired', async () => {
    secretRows = [
      healthy({ tokenExpiresAt: new Date(NOW + CREDENTIAL_PREFLIGHT_MARGIN_MS - 1) }),
      healthy(),
    ];
    const result = await preflightBackendCredential(claude);
    expect(mockRefreshClaude).toHaveBeenCalled();
    expect(result.state).toBe('ok');
  });

  it('reports unhealthy AND revoked when the refresh itself reports the credential revoked', async () => {
    secretRows = [healthy({ tokenExpiresAt: new Date(NOW - 1000) })];
    mockRefreshClaude.mockImplementation(async () => 'revoked');
    const result = await preflightBackendCredential(claude);
    expect(result.state).toBe('unhealthy');
    expect(result.revoked).toBe(true);
  });

  it('re-reads the row after a locked refresh rather than guessing', async () => {
    secretRows = [
      healthy({ tokenExpiresAt: new Date(NOW - 1000) }),
      healthy({ tokenExpiresAt: new Date(NOW + 60 * 60 * 1000) }),
    ];
    mockRefreshClaude.mockImplementation(async () => 'locked');
    const result = await preflightBackendCredential(claude);
    expect(result.state).toBe('ok');
  });

  // AC-AQR-21
  it('reports unknown when no managed credential row exists at either scope', async () => {
    secretRows = [undefined, undefined];
    const result = await preflightBackendCredential(claude);
    expect(result.state).toBe('unknown');
  });

  it('reports unknown when the worker has no team', async () => {
    const result = await preflightBackendCredential({ ...claude, teamId: null });
    expect(result.state).toBe('unknown');
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  // AC-AQR-22
  it('reports unknown when the refresh throws', async () => {
    secretRows = [healthy({ tokenExpiresAt: new Date(NOW - 1000) })];
    mockRefreshClaude.mockImplementation(async () => { throw new Error('provider down'); });
    const result = await preflightBackendCredential(claude);
    expect(result.state).toBe('unknown');
  });

  it('reports unknown when the credential lookup throws', async () => {
    mockFindFirst.mockImplementation(async () => { throw new Error('db down'); });
    const result = await preflightBackendCredential(claude);
    expect(result.state).toBe('unknown');
  });

  it('prefers a workspace-scoped credential over the team-wide one', async () => {
    secretRows = [healthy({ id: 'ws-secret' })];
    const result = await preflightBackendCredential(claude);
    expect(result.state).toBe('ok');
    // Only the workspace lookup ran; the team-wide fallback was not needed.
    expect(findFirstCalls).toHaveLength(1);
  });

  it('falls back to the team-wide credential when the workspace has none', async () => {
    secretRows = [undefined, healthy({ id: 'team-secret' })];
    const result = await preflightBackendCredential(claude);
    expect(result.state).toBe('ok');
    expect(findFirstCalls).toHaveLength(2);
  });

  it('routes a codex worker through the codex refresh, not the claude one', async () => {
    secretRows = [
      healthy({ tokenExpiresAt: new Date(NOW - 1000) }),
      healthy(),
    ];
    await preflightBackendCredential({ ...claude, backend: 'codex' });
    expect(mockRefreshCodex).toHaveBeenCalledWith('secret-1');
    expect(mockRefreshClaude).not.toHaveBeenCalled();
  });
});
