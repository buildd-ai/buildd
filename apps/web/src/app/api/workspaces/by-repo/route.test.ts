import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Reach is decided by the real listReachableWorkspaceIds (lib/workspace-access.ts);
// only its data sources are stubbed. Assertions are on responses, never on the
// rendered `where` (bun's mock.module is process-global, so drizzle may be stubbed).

const ACCOUNT = { id: 'acct-a', teamId: 'team-a', name: 'runner' };

let apiAccount: any = ACCOUNT;
let sessionUser: any = null;
let links: Array<{ workspaceId: string; canClaim: boolean; canCreate: boolean }> = [];
let ownOpenRows: Array<{ id: string; teamId: string; accessMode: string }> = [];
let userWorkspaceIds: string[] = [];
let matched: Record<string, any> | undefined;

const mockFindFirst = mock(async () => matched);

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => apiAccount }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => sessionUser }));
mock.module('@/lib/repo-scope', () => ({ workspaceRepoMatches: (repo: string) => ({ repo }) }));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: async () => links,
}));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['team-u'],
  getUserWorkspaceIds: async () => userWorkspaceIds,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockFindFirst, findMany: async () => ownOpenRows },
      accountWorkspaces: { findFirst: async () => undefined, findMany: async () => [] },
    },
  },
}));

import { GET } from './route';

function req(opts: { auth?: boolean; repo?: string } = {}) {
  const { auth = true, repo = 'owner/repo' } = opts;
  return new NextRequest(`http://localhost:3000/api/workspaces/by-repo?repo=${repo}`, {
    headers: new Headers(auth ? { authorization: 'Bearer bld_test' } : {}),
  });
}

function ws(id: string, teamId: string, extra: Record<string, any> = {}) {
  return { id, teamId, name: `ws ${id}`, repo: 'owner/repo', accessMode: 'open', ...extra };
}

describe('GET /api/workspaces/by-repo', () => {
  beforeEach(() => {
    apiAccount = ACCOUNT;
    sessionUser = null;
    links = [];
    ownOpenRows = [];
    userWorkspaceIds = [];
    matched = undefined;
    mockFindFirst.mockClear();
  });

  it('401 without an API key or session', async () => {
    apiAccount = null;
    const res = await GET(req({ auth: false }));
    expect(res.status).toBe(401);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("200 for the account's own team's open workspace", async () => {
    ownOpenRows = [{ id: 'ws-own', teamId: 'team-a', accessMode: 'open' }];
    matched = ws('ws-own', 'team-a');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).workspace.id).toBe('ws-own');
  });

  it('200 for a workspace in another team the account is explicitly linked to', async () => {
    links = [{ workspaceId: 'ws-linked', canClaim: true, canCreate: false }];
    matched = ws('ws-linked', 'team-b', { accessMode: 'restricted' });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).workspace.id).toBe('ws-linked');
  });

  it("404 for another team's open workspace (no link)", async () => {
    // The own-team query can only return team-a rows; even if a team-b row came
    // back, the reach rule drops it.
    ownOpenRows = [{ id: 'ws-other', teamId: 'team-b', accessMode: 'open' }];
    matched = ws('ws-other', 'team-b');
    const res = await GET(req());
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('ws-other');
  });

  it("404 for another team's workspace even when the account reaches others", async () => {
    ownOpenRows = [{ id: 'ws-own', teamId: 'team-a', accessMode: 'open' }];
    matched = ws('ws-other', 'team-b');
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('ws-other');
  });

  it('404 (same as unreachable) when no workspace matches the repo', async () => {
    ownOpenRows = [{ id: 'ws-own', teamId: 'team-a', accessMode: 'open' }];
    matched = undefined;
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Workspace not found' });
  });

  it("404 for the account's own team's restricted workspace without a link", async () => {
    ownOpenRows = [{ id: 'ws-restricted', teamId: 'team-a', accessMode: 'restricted' }];
    matched = ws('ws-restricted', 'team-a', { accessMode: 'restricted' });
    const res = await GET(req());
    expect(res.status).toBe(404);
  });

  it("200 for a session user's team workspace; 404 outside their teams", async () => {
    apiAccount = null;
    sessionUser = { id: 'user-1' };
    userWorkspaceIds = ['ws-team'];

    matched = ws('ws-team', 'team-u', { accessMode: 'restricted' });
    const ok = await GET(req({ auth: false }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).workspace.id).toBe('ws-team');

    matched = ws('ws-elsewhere', 'team-z');
    expect((await GET(req({ auth: false }))).status).toBe(404);
  });

  it('400 without a repo parameter', async () => {
    const res = await GET(new NextRequest('http://localhost:3000/api/workspaces/by-repo', {
      headers: new Headers({ authorization: 'Bearer bld_test' }),
    }));
    expect(res.status).toBe(400);
  });

  it('never returns webhook_config secrets', async () => {
    ownOpenRows = [{ id: 'ws-1', teamId: 'team-a', accessMode: 'open' }];
    matched = ws('ws-1', 'team-a', {
      webhookConfig: { url: 'https://hooks.example.test', token: 'tok-SHOULD-NOT-LEAK', enabled: true },
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('SHOULD-NOT-LEAK');
    expect(body).not.toMatch(/"token"\s*:/);
    const { workspace } = JSON.parse(body);
    expect(workspace.id).toBe('ws-1');
    expect(workspace.webhookConfig.hasToken).toBe(true);
  });
});
