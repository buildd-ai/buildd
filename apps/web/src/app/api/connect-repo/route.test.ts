/**
 * /app/connect-repo and its confirm (lib/connect-repo.ts): where a T3 thread
 * on `buildd acp` sends a person whose project matched no workspace the runner
 * reaches. Three cases: pick this runner for an existing workspace, create the
 * workspace and pick it, or already fine. Only a signed-in person confirms
 * (spec "One runner for every team you run", R-8).
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { accounts, githubInstallations, teamMembers, workerHeartbeats, workspaces } from '@buildd/core/db/schema';

process.env.OAUTH_JWT_SECRET = 'connect-repo-test-secret-0123456789abcdef';
delete process.env.OAUTH_ISSUER;

const ORIGIN = 'http://localhost:3000';
const KEY = '11111111-2222-4333-8444-555555555555';
const REPO = 'acme/app';

const key = (picks: any[] | null = []) => ({ id: KEY, name: 'Laptop', homeTeamId: 'team-a', homeTeamName: 'Alpha', picks });
const wsApp = { id: 'ws-app', name: 'app', repo: 'acme/app', accessMode: 'open' };
const wsOther = { id: 'ws-other', name: 'other', repo: 'acme/other', accessMode: 'open' };

let personTeams: any[] = [];
let memberships: any[] = [];
let installs: any[] = [];
let teamKeyRows: any[] = [];
let heartbeatRows: any[] = [];
let workspaceRows: any[] = [];
let updatedWorkspaces: any[] = [];

const mockAuth = mock(async () => ({ user: { id: 'user-1' } }) as any);
const mockList = mock(async (_u: string) => [key()] as any[]);
const mockAddPick = mock(async (_a: any) => ({ ok: true, workspaceIds: [] }) as any);
const mockCreate = mock(async (_a: any) => ({ ok: true, workspace: { id: 'ws-new', name: 'app' } }) as any);
const mockCan = mock(async (_actor: any, _perm: string, _team: string) => true);
const mockGithubApi = mock(async (_i: number, _p: string) => ({
  id: 42, name: 'app', full_name: 'acme/app', owner: { login: 'acme' }, private: true, default_branch: 'dev', html_url: 'https://github.com/acme/app',
}) as any);

mock.module('@/auth', () => ({ auth: mockAuth }));
mock.module('@/lib/runner-picks', () => ({ listRunnerKeys: mockList, addRunnerPick: mockAddPick }));
mock.module('@/lib/mcp-grant-admin', () => ({ consentTeamsForUser: async () => personTeams }));
mock.module('@/lib/workspace-create', () => ({ createWorkspace: mockCreate }));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));
mock.module('@/lib/permissions', () => ({ can: mockCan }));
mock.module('@/lib/workspace-installation', () => ({
  teamInstallationIdForOwner: async (owner: string, teamId: string) =>
    installs.find((i) => i.login === owner && i.owners.includes(teamId))?.installationId ?? null,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => {
      let table: unknown;
      const chain: any = {
        from(t: unknown) { table = t; return chain; },
        innerJoin() { return chain; },
        where() {
          const rows = table === teamMembers ? memberships : table === githubInstallations ? installs.map((i) => ({ id: i.id })) : table === accounts ? teamKeyRows
            : table === workerHeartbeats ? heartbeatRows : table === workspaces ? workspaceRows : [];
          return Object.assign(Promise.resolve(rows), { orderBy: () => ({ limit: () => Promise.resolve(rows) }) });
        },
      };
      return chain;
    },
    update: (t: unknown) => ({ set: (v: any) => ({ where: () => { updatedWorkspaces.push({ table: t, set: v }); return Promise.resolve(); } }) }),
  },
}));

const { POST } = await import('./route');
const { resolveConnectRepo, createConnectToken } = await import('@/lib/connect-repo');

function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}/api/connect-repo`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers },
    body: new URLSearchParams({ repo: REPO, runner: KEY, token: createConnectToken('user-1', KEY, REPO), ...fields }).toString(),
  });
}

beforeEach(() => {
  personTeams = [{ id: 'team-a', name: 'Alpha', role: 'owner', workspaces: [wsApp, wsOther] }];
  memberships = [{ id: 'team-a', name: 'Alpha' }];
  installs = [{ id: 'inst-1', installationId: 7, login: 'acme', owners: ['team-a'] }];
  teamKeyRows = [];
  heartbeatRows = [];
  workspaceRows = [];
  updatedWorkspaces = [];
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
  mockList.mockReset();
  mockList.mockResolvedValue([key()]);
  mockAddPick.mockClear();
  mockCreate.mockClear();
  mockCan.mockReset();
  mockCan.mockResolvedValue(true);
});

describe('connect-repo: the page cases', () => {
  it('a workspace for the repo the runner is not picked for: offers that pick', async () => {
    const found = await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO });
    expect(found).toEqual({ kind: 'pick', runnerName: 'Laptop', workspaces: [{ id: 'ws-app', name: 'app', teamId: 'team-a', teamName: 'Alpha' }] });
  });

  it('matches the repo whatever its case or clone-URL form', async () => {
    personTeams[0].workspaces = [{ ...wsApp, repo: 'https://github.com/Acme/App.git' }];
    const found = await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: 'acme/app' });
    expect(found.kind).toBe('pick');
  });

  it('no workspace for the repo: offers to create it in a team with the GitHub App on its owner', async () => {
    personTeams[0].workspaces = [wsOther];
    const found = await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO });
    expect(found).toEqual({ kind: 'create', runnerName: 'Laptop', teams: [{ id: 'team-a', name: 'Alpha' }] });
  });

  it('no workspace and no installation for the owner: says to install the GitHub App', async () => {
    personTeams[0].workspaces = [wsOther];
    installs = [];
    expect((await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO })).kind).toBe('install_github');
  });

  it('no workspace and no team the person may create in: says a team admin must', async () => {
    personTeams[0].workspaces = [wsOther];
    mockCan.mockResolvedValue(false);
    expect((await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO })).kind).toBe('no_team');
  });

  it('the runner already reaches it: says so', async () => {
    mockList.mockResolvedValue([key([{ workspaceId: 'ws-app', reachable: true, removedByAdmin: false }])]);
    const found = await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO });
    expect(found.kind).toBe('already');
  });

  const containerRunner = {
    platform: 'linux-container', evidence: [],
    claude: { mechanism: 'none', scope: [], reason: 'opt_out' },
    codex: { 'read-only': { mechanism: 'none', scope: [], reason: 'opt_out' }, 'workspace-write': { mechanism: 'none', scope: [], reason: 'opt_out' } },
    probeAt: '2026-10-17T00:00:01.000Z', processStartedAt: '2026-10-17T00:00:00.000Z', runnerVersion: '1.0.0', reducedOptIn: true,
  };
  const cannotConfine = () => {
    heartbeatRows = [{ isolation: containerRunner }];
    workspaceRows = [{ gitConfig: { isolationPolicy: 'protected' }, accessMode: 'open' }];
  };

  it('the runner already reaches it but cannot confine what the workspace asks: shows it and offers the one fix', async () => {
    mockList.mockResolvedValue([key([{ workspaceId: 'ws-app', reachable: true, removedByAdmin: false }])]);
    cannotConfine();
    const found: any = await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO });
    expect(found.kind).toBe('already');
    expect(found.workspace.isolationBlocked).toEqual({ canFix: true });
  });

  it('a person who may not change workspace settings sees it but is not offered the fix, and confirming changes nothing', async () => {
    mockList.mockResolvedValue([key([{ workspaceId: 'ws-app', reachable: true, removedByAdmin: false }])]);
    cannotConfine();
    mockCan.mockImplementation(async (_a: any, perm: string) => perm !== 'manage_workspace_settings');
    const found: any = await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO });
    expect(found.workspace.isolationBlocked).toEqual({ canFix: false });
    const res = await POST(post({ trustLocal: '1' }));
    expect(res.status).toBe(303);
    expect(updatedWorkspaces).toHaveLength(0);
  });

  it('confirming sets the workspace to trusted local', async () => {
    mockList.mockResolvedValue([key([{ workspaceId: 'ws-app', reachable: true, removedByAdmin: false }])]);
    cannotConfine();
    const res = await POST(post({ trustLocal: '1' }));
    expect(res.status).toBe(303);
    expect(updatedWorkspaces).toHaveLength(1);
    expect(res.headers.get('location')).toContain('trusted=1');
  });

  it('a runner that can serve the workspace is left alone even if trustLocal is posted', async () => {
    mockList.mockResolvedValue([key([{ workspaceId: 'ws-app', reachable: true, removedByAdmin: false }])]);
    await POST(post({ trustLocal: '1' }));
    expect(updatedWorkspaces).toHaveLength(0);
  });

  it('a workspace to pick that the runner cannot confine carries the same flag', async () => {
    cannotConfine();
    const found: any = await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO });
    expect(found.kind).toBe('pick');
    expect(found.workspaces[0].isolationBlocked).toEqual({ canFix: true });
  });

  it('a workspace a team admin removed this runner from is not offered again', async () => {
    mockList.mockResolvedValue([key([{ workspaceId: 'ws-app', reachable: false, removedByAdmin: true }])]);
    const found = await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO });
    expect(found.kind).toBe('blocked');
  });

  it('a restricted workspace in a team where the person is a member is not offered', async () => {
    personTeams = [{ id: 'team-a', name: 'Alpha', role: 'member', workspaces: [{ ...wsApp, accessMode: 'restricted' }] }];
    const found = await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO });
    expect(found.kind).toBe('blocked');
  });

  it("another person's runner reads as not found", async () => {
    mockList.mockResolvedValue([]);
    expect((await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO })).kind).toBe('key_not_found');
  });

  it("a team's runner key in one of the person's teams: says it is the team's and how to use the machine across teams", async () => {
    mockList.mockResolvedValue([]);
    teamKeyRows = [{ name: 'coder-workspace', teamName: 'Alpha' }];
    expect(await resolveConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO })).toEqual({ kind: 'team_key', runnerName: 'coder-workspace', teamName: 'Alpha' });
  });

  it('confirm on a team key changes nothing', async () => {
    mockList.mockResolvedValue([]);
    teamKeyRows = [{ name: 'coder-workspace', teamName: 'Alpha' }];
    const { confirmConnectRepo } = await import('@/lib/connect-repo');
    const r = await confirmConnectRepo({ userId: 'user-1', accountId: KEY, repo: REPO, workspaceId: 'ws-app', origin: ORIGIN });
    expect(r.ok).toBe(false);
    expect(mockAddPick).not.toHaveBeenCalled();
  });
});

describe('POST /api/connect-repo', () => {
  it('pick: writes the pick through addRunnerPick and returns to the page', async () => {
    const res = await POST(post({ workspaceId: 'ws-app' }));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/app/connect-repo');
    expect(loc.searchParams.get('error')).toBeNull();
    expect(mockAddPick).toHaveBeenCalledWith({ accountId: KEY, userId: 'user-1', workspaceId: 'ws-app' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('pick: a workspace the page does not offer is refused', async () => {
    const res = await POST(post({ workspaceId: 'ws-other' }));
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toContain('not one you can pick');
    expect(mockAddPick).not.toHaveBeenCalled();
  });

  it('create: creates the workspace through the installation its team owns, then picks the runner', async () => {
    personTeams[0].workspaces = [wsOther];
    const res = await POST(post({ teamId: 'team-a' }));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).searchParams.get('created')).toBe('1');
    expect(mockGithubApi).toHaveBeenCalledWith(7, '/repos/acme/app');
    const input = mockCreate.mock.calls[0][0];
    expect(input).toMatchObject({ teamId: 'team-a', name: 'app', repoUrl: 'acme/app', githubInstallationId: 'inst-1', userId: 'user-1' });
    expect(input.githubRepo).toMatchObject({ repoId: 42, fullName: 'acme/app', owner: 'acme', defaultBranch: 'dev' });
    expect(mockAddPick).toHaveBeenCalledWith({ accountId: KEY, userId: 'user-1', workspaceId: 'ws-new' });
  });

  it('create: a team the person may not create in is refused', async () => {
    personTeams[0].workspaces = [wsOther];
    const res = await POST(post({ teamId: 'team-z' }));
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toContain('cannot create');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('already fine: changes nothing', async () => {
    mockList.mockResolvedValue([key([{ workspaceId: 'ws-app', reachable: true, removedByAdmin: false }])]);
    const res = await POST(post({ workspaceId: 'ws-app' }));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBeNull();
    expect(mockAddPick).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('an API key cannot confirm (R-8)', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(post({ workspaceId: 'ws-app' }, { authorization: 'Bearer bld_runnerkey' }));
    expect(res.status).toBe(403);
    expect(mockAddPick).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('no session: refused', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(post({ workspaceId: 'ws-app' }))).status).toBe(401);
    expect(mockAddPick).not.toHaveBeenCalled();
  });

  it("a form shown to another person, or posted from another site, is refused", async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-2' } });
    expect((await POST(post({ workspaceId: 'ws-app' }))).status).toBe(403);
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    expect((await POST(post({ workspaceId: 'ws-app' }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect(mockAddPick).not.toHaveBeenCalled();
  });
});
