/**
 * Connecting, replacing or removing a workspace's Claude or Codex credential
 * (team-wide or workspace-wide) requires manage_team_credentials in the
 * workspace's team. Refreshing an existing one rotates it in place and stays
 * open to any member. Each case asserts whether the store/delete happened, not
 * only the status.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(async () => ({ id: 'user-1' }) as any);
const mockVerifyWorkspaceAccess = mock(async () => ({ teamId: 'team-1' }) as any);

// Teams in which user-1 holds manage_team_credentials (role grant + overrides).
let grantedTeams: string[] = [];
const mockCan = mock(async (caller: any, permission: string, teamId: string) =>
  caller.kind === 'user' && caller.userId === 'user-1' && permission === 'manage_team_credentials' && grantedTeams.includes(teamId));

const mockStoreClaude = mock(async () => {});
const mockDeleteClaude = mock(async () => {});
const mockStoreCodex = mock(async () => {});
const mockDeleteCodex = mock(async () => {});
const mockClaudeOAuthStart = mock(() => ({ url: 'https://example.test/authorize', verifier: 'v', state: 's' }));
const mockClaudeOAuthExchange = mock(async () => ({ ok: true, credential: { access_token: 'a', refresh_token: 'r' } }) as any);
const mockCodexDeviceStart = mock(async () => ({ ok: true, value: { deviceAuthId: 'd', userCode: 'u' } }) as any);
const mockCodexDevicePoll = mock(async () => ({ status: 'authorized', authJson: { access_token: 'a', refresh_token: 'r' } }) as any);
const mockRefreshClaude = mock(async () => 'refreshed' as any);
const mockRefreshCodex = mock(async () => 'refreshed' as any);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));
mock.module('@/lib/permissions', () => ({ can: mockCan }));
mock.module('@/lib/credential-recovery', () => ({ requeueAuthFailedTasks: async () => ({ requeued: [] }) }));
mock.module('@/lib/claude-credential', () => ({
  storeClaudeCredential: mockStoreClaude,
  deleteClaudeCredential: mockDeleteClaude,
  getClaudeStatus: async () => ({ connected: true }),
  getClaudeSecretId: async () => 'secret-claude',
  refreshClaudeCredential: mockRefreshClaude,
  normalizeClaudeCredentialsJson: (v: unknown) => ({ ok: true, value: v }),
}));
mock.module('@/lib/codex-credential', () => ({
  storeCodexCredential: mockStoreCodex,
  deleteCodexCredential: mockDeleteCodex,
  getCodexStatus: async () => ({ connected: true }),
  getCodexSecretId: async () => 'secret-codex',
  refreshCodexCredential: mockRefreshCodex,
  normalizeCodexAuthJson: (v: unknown) => ({ ok: true, value: v }),
}));
mock.module('@/lib/claude-oauth-login', () => ({
  startClaudeOAuthLogin: mockClaudeOAuthStart,
  exchangeClaudeOAuthCode: mockClaudeOAuthExchange,
}));
mock.module('@/lib/codex-device-auth', () => ({
  startCodexDeviceAuth: mockCodexDeviceStart,
  pollCodexDeviceAuth: mockCodexDevicePoll,
}));

const claude = await import('./claude-credential/route');
const claudeOAuthStart = await import('./claude-credential/oauth/start/route');
const claudeOAuthExchange = await import('./claude-credential/oauth/exchange/route');
const claudeRefresh = await import('./claude-credential/refresh/route');
const codex = await import('./codex-credential/route');
const codexDeviceStart = await import('./codex-credential/device/start/route');
const codexDevicePoll = await import('./codex-credential/device/poll/route');
const codexRefresh = await import('./codex-credential/refresh/route');

const PARAMS = () => ({ params: Promise.resolve({ id: 'ws-1' }) });
const req = (method: string, path: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/workspaces/ws-1/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

type Case = {
  name: string;
  call: (scope: 'team' | 'workspace') => Promise<Response>;
  /** The write the handler makes once the provider side is done. */
  effect: ReturnType<typeof mock>;
  /** Handlers that only start a flow write nothing; they must not reach the provider either. */
  provider?: ReturnType<typeof mock>;
};

const GATED: Case[] = [
  {
    name: 'claude-credential POST',
    call: scope => claude.POST(req('POST', 'claude-credential', { credentialsJson: '{"access_token":"a"}', scope }), PARAMS()),
    effect: mockStoreClaude,
  },
  {
    name: 'claude-credential DELETE',
    call: scope => claude.DELETE(req('DELETE', `claude-credential?scope=${scope}`), PARAMS()),
    effect: mockDeleteClaude,
  },
  {
    name: 'claude-credential/oauth/start',
    call: () => claudeOAuthStart.POST(req('POST', 'claude-credential/oauth/start'), PARAMS()),
    effect: mockClaudeOAuthStart,
  },
  {
    name: 'claude-credential/oauth/exchange',
    call: scope => claudeOAuthExchange.POST(req('POST', 'claude-credential/oauth/exchange', { code: 'c', verifier: 'v', state: 's', scope }), PARAMS()),
    effect: mockStoreClaude,
    provider: mockClaudeOAuthExchange,
  },
  {
    name: 'codex-credential POST',
    call: scope => codex.POST(req('POST', 'codex-credential', { authJson: '{"access_token":"a"}', scope }), PARAMS()),
    effect: mockStoreCodex,
  },
  {
    name: 'codex-credential DELETE',
    call: scope => codex.DELETE(req('DELETE', `codex-credential?scope=${scope}`), PARAMS()),
    effect: mockDeleteCodex,
  },
  {
    name: 'codex-credential/device/start',
    call: () => codexDeviceStart.POST(req('POST', 'codex-credential/device/start'), PARAMS()),
    effect: mockCodexDeviceStart,
  },
  {
    name: 'codex-credential/device/poll',
    call: scope => codexDevicePoll.POST(req('POST', 'codex-credential/device/poll', { deviceAuthId: 'd', userCode: 'u', scope }), PARAMS()),
    effect: mockStoreCodex,
    provider: mockCodexDevicePoll,
  },
];

const ALL_MOCKS = [
  mockStoreClaude, mockDeleteClaude, mockStoreCodex, mockDeleteCodex, mockClaudeOAuthStart,
  mockClaudeOAuthExchange, mockCodexDeviceStart, mockCodexDevicePoll, mockRefreshClaude, mockRefreshCodex, mockCan,
];

beforeEach(() => {
  for (const m of ALL_MOCKS) m.mockClear();
  mockVerifyWorkspaceAccess.mockClear();
  mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1' });
  grantedTeams = [];
});

describe('workspace Claude/Codex credential writes need manage_team_credentials', () => {
  for (const c of GATED) {
    for (const scope of ['team', 'workspace'] as const) {
      it(`${c.name} (scope=${scope}) refuses a member and writes nothing`, async () => {
        const res = await c.call(scope);
        expect(res.status).toBe(403);
        expect(c.effect).not.toHaveBeenCalled();
        if (c.provider) expect(c.provider).not.toHaveBeenCalled();
        expect(mockCan).toHaveBeenCalledWith({ kind: 'user', userId: 'user-1' }, 'manage_team_credentials', 'team-1');
      });

      it(`${c.name} (scope=${scope}) proceeds for a holder of the permission`, async () => {
        grantedTeams = ['team-1'];
        const res = await c.call(scope);
        expect(res.status).toBeLessThan(300);
        expect(c.effect).toHaveBeenCalledTimes(1);
      });
    }

    it(`${c.name} checks the workspace's team, not another team the caller manages`, async () => {
      grantedTeams = ['team-2'];
      const res = await c.call('team');
      expect(res.status).toBe(403);
      expect(c.effect).not.toHaveBeenCalled();
    });

    it(`${c.name} still 404s a workspace the caller cannot see, before the permission check`, async () => {
      mockVerifyWorkspaceAccess.mockResolvedValue(null);
      grantedTeams = ['team-1'];
      const res = await c.call('team');
      expect(res.status).toBe(404);
      expect(c.effect).not.toHaveBeenCalled();
    });
  }
});

describe('refreshing an existing credential stays open to any member', () => {
  const prev = process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH;
  beforeEach(() => { process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH = 'true'; });
  afterEach(() => {
    if (prev === undefined) delete process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH;
    else process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH = prev;
  });

  it('claude-credential/refresh rotates for a plain member', async () => {
    const res = await claudeRefresh.POST(req('POST', 'claude-credential/refresh'), PARAMS());
    expect(res.status).toBe(200);
    expect(mockRefreshClaude).toHaveBeenCalledWith('secret-claude');
  });

  it('codex-credential/refresh rotates for a plain member', async () => {
    const res = await codexRefresh.POST(req('POST', 'codex-credential/refresh'), PARAMS());
    expect(res.status).toBe(200);
    expect(mockRefreshCodex).toHaveBeenCalledWith('secret-codex');
  });
});
