import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(async () => ({ id: 'user-1' }) as any);
const mockVerifyWorkspaceAccess = mock(async () => ({ teamId: 'team-1' }) as any);
const mockExchange = mock(async () => ({ ok: true, credential: { access_token: 'a', refresh_token: 'r' } }) as any);
const mockStore = mock(async () => {});
const mockStatus = mock(async () => ({ connected: true }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  getUserTeamIds: async () => ['team-1', 'team-2'],
}));
mock.module('@/lib/claude-oauth-login', () => ({ exchangeClaudeOAuthCode: mockExchange }));
mock.module('@/lib/claude-credential', () => ({ storeClaudeCredential: mockStore, getClaudeStatus: mockStatus }));
mock.module('@/lib/credential-recovery', () => ({ requeueAuthFailedTasks: async () => {} }));

const { POST } = await import('./route');

const PARAMS = { params: Promise.resolve({ id: 'ws-1' }) };
const req = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/workspaces/ws-1/claude-credential/oauth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST claude-credential/oauth/exchange', () => {
  beforeEach(() => {
    mockExchange.mockClear();
    mockStore.mockClear();
  });

  // Anthropic rotates the refresh token on every use. Copies in N team rows
  // refresh independently, so the first refresh kills every other copy.
  it('refuses all_teams before spending the code, and stores nothing', async () => {
    const res = await POST(req({ code: 'c', verifier: 'v', state: 's', scope: 'all_teams' }), PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('API key');
    expect(mockExchange).not.toHaveBeenCalled();
    expect(mockStore).not.toHaveBeenCalled();
  });

  it('still stores a team-scoped sign-in', async () => {
    const res = await POST(req({ code: 'c', verifier: 'v', state: 's', scope: 'team' }), PARAMS);
    expect(res.status).toBe(200);
    expect(mockStore).toHaveBeenCalledTimes(1);
    expect(mockStore.mock.calls[0][0]).toEqual({ teamId: 'team-1' });
  });
});
