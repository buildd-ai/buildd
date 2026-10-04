import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'ws-new', name: 'New Workspace' }]),
  })),
}));
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockGetUserDefaultTeamId = mock(() => Promise.resolve('team-1'));
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

const mockGetAccountWorkspacePermissions = mock(() => Promise.resolve([] as any[]));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mockGetAccountWorkspacePermissions,
}));

mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
  getUserDefaultTeamId: mockGetUserDefaultTeamId,
  getUserTeamIds: mockGetUserTeamIds,
}));

const mockGetInstallationOwnerTeamIds = mock(async (_id: string) => ['team-1'] as string[]);
mock.module('@/lib/github-installation-access', () => ({
  getInstallationOwnerTeamIds: mockGetInstallationOwnerTeamIds,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
    insert: () => mockWorkspacesInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  inArray: (field: any, values: any) => ({ field, values, type: 'inArray' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accountWorkspaces: { accountId: 'accountId' },
  workspaces: { id: 'id', teamId: 'teamId', createdAt: 'createdAt', accessMode: 'accessMode' },
}));

// Override NODE_ENV for tests
const originalNodeEnv = process.env.NODE_ENV;

import { GET, POST } from './route';

function createMockGetRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/workspaces', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

function createMockPostRequest(body?: any): NextRequest {
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workspaces', init);
}

describe('GET /api/workspaces', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
    mockGetAccountWorkspacePermissions.mockReset();
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);
    mockWorkspacesFindMany.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when no auth', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it('returns workspaces for session auth', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindMany.mockResolvedValue([
      {
        id: 'ws-1',
        name: 'My Workspace',
        accountWorkspaces: [
          { accountId: 'acc-1', account: { type: 'user', name: 'Runner' }, canClaim: true, canCreate: false },
        ],
      },
    ]);

    const req = createMockGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].name).toBe('My Workspace');
    expect(data.workspaces[0].runners).toBeDefined();
  });

  it('returns workspaces for API key auth', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockGetCurrentUser.mockResolvedValue(null);
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);
    // First call returns open workspaces (empty), second call returns full workspace data
    mockWorkspacesFindMany
      .mockResolvedValueOnce([]) // open workspaces
      .mockResolvedValueOnce([   // batch fetch by IDs
        {
          id: 'ws-1',
          name: 'Linked Workspace',
          accountWorkspaces: [],
        },
      ]);

    const req = createMockGetRequest({ Authorization: 'Bearer bld_test' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaces).toHaveLength(1);
  });

  it('scopes to teamId when the user is a member of that team', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Team2 WS', accountWorkspaces: [] },
    ]);

    const req = new NextRequest('http://localhost:3000/api/workspaces?teamId=team-2', {
      method: 'GET',
      headers: new Headers(),
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaces).toHaveLength(1);
  });

  it('returns empty (no leak) when teamId is a team the user is NOT in', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindMany.mockReset();

    const req = new NextRequest('http://localhost:3000/api/workspaces?teamId=team-other', {
      method: 'GET',
      headers: new Headers(),
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaces).toEqual([]);
    expect(mockWorkspacesFindMany).not.toHaveBeenCalled();
  });
});

// Evaluates the mocked drizzle predicates above against fixture rows, so the
// scoping the route asks the db for is what decides the result — a mock that
// returned rows regardless of WHERE would hide exactly the leak under test.
function matches(p: any, row: Record<string, unknown>): boolean {
  if (!p) return true;
  if (p.type === 'eq') return row[p.field] === p.value;
  if (p.type === 'inArray') return p.values.includes(row[p.field]);
  if (p.type === 'and') return p.args.filter(Boolean).every((a: any) => matches(a, row));
  throw new Error(`unhandled predicate ${p.type}`);
}

describe('GET /api/workspaces — API-account reach (shared rule)', () => {
  const FIXTURE = [
    { id: 'ws-own-open', teamId: 'team-a', accessMode: 'open', name: 'own open', accountWorkspaces: [] },
    { id: 'ws-own-restricted', teamId: 'team-a', accessMode: 'restricted', name: 'own restricted', accountWorkspaces: [] },
    { id: 'ws-linked', teamId: 'team-b', accessMode: 'restricted', name: 'linked', accountWorkspaces: [] },
    { id: 'ws-foreign-open', teamId: 'team-b', accessMode: 'open', name: 'foreign open', accountWorkspaces: [] },
  ];

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-a', teamId: 'team-a' });
    mockGetAccountWorkspacePermissions.mockReset();
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-linked', canClaim: true, canCreate: true },
    ]);
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockImplementation(async (opts: any) => FIXTURE.filter(r => matches(opts?.where, r)));
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  async function listedIds(): Promise<string[]> {
    const res = await GET(createMockGetRequest({ Authorization: 'Bearer bld_test' }));
    expect(res.status).toBe(200);
    return (await res.json()).workspaces.map((w: any) => w.id).sort();
  }

  it("lists the account's own team's open workspaces", async () => {
    expect(await listedIds()).toContain('ws-own-open');
  });

  it('lists a workspace the account is explicitly linked to, in another team', async () => {
    expect(await listedIds()).toContain('ws-linked');
  });

  it("never lists another team's open workspace", async () => {
    expect(await listedIds()).not.toContain('ws-foreign-open');
  });

  it('does not list a restricted workspace of its own team without a link', async () => {
    expect(await listedIds()).toEqual(['ws-linked', 'ws-own-open']);
  });

  it('never serialises whole account rows for connected accounts', async () => {
    await listedIds();
    const byIds = mockWorkspacesFindMany.mock.calls.find((c: any) => c[0]?.with)?.[0] as any;
    expect(byIds.with.accountWorkspaces.with.account).toEqual({ columns: { id: true, name: true, type: true } });
  });
});

// The listing is an allowlist of workspace fields. webhook_config holds a
// plaintext bearer token (and ingest configs a webhookSecret/callbackToken);
// none of it may reach the caller, whichever auth path listed the workspace.
describe('GET /api/workspaces — no secrets in the listing', () => {
  const SECRET_ROW = {
    id: 'ws-1',
    name: 'Secretive',
    repo: 'owner/repo',
    teamId: 'team-a',
    accessMode: 'open',
    gitConfig: { defaultBranch: 'main' },
    webhookConfig: {
      url: 'https://hooks.example.test/agent',
      token: 'tok-SHOULD-NOT-LEAK',
      enabled: true,
      runnerPreference: 'any',
      events: ['task.created', 'task.retry'],
      webhookSecret: 'whsec-SHOULD-NOT-LEAK',
      callbackToken: 'cb-SHOULD-NOT-LEAK',
    },
    someFutureColumn: 'future-SHOULD-NOT-LEAK',
    accountWorkspaces: [
      { accountId: 'acc-1', account: { id: 'acc-1', type: 'user', name: 'Runner' }, canClaim: true, canCreate: false },
    ],
  };

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetAccountWorkspacePermissions.mockReset();
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);
    mockGetUserWorkspaceIds.mockReset();
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockResolvedValue([SECRET_ROW]);
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  function expectNoSecrets(body: string) {
    expect(body).not.toContain('SHOULD-NOT-LEAK');
    expect(body).not.toMatch(/"token"\s*:/);
    expect(body).not.toMatch(/"webhookSecret"\s*:/);
    expect(body).not.toMatch(/"callbackToken"\s*:/);
  }

  it('session listing carries no token/secret fields', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const res = await GET(createMockGetRequest());
    expect(res.status).toBe(200);
    const body = await res.text();
    expectNoSecrets(body);
    const ws = JSON.parse(body).workspaces[0];
    // Non-secret fields consumers read survive.
    expect(ws).toMatchObject({ id: 'ws-1', name: 'Secretive', repo: 'owner/repo', accessMode: 'open', teamId: 'team-a' });
    expect(ws.gitConfig).toEqual({ defaultBranch: 'main' });
    // `events` is listed so the cloud runner's deploy can see whether it opted in.
    expect(ws.webhookConfig).toEqual({
      url: 'https://hooks.example.test/agent', enabled: true, runnerPreference: 'any', hasToken: true,
      events: ['task.created', 'task.retry'],
    });
    expect(ws.connectedAccounts).toHaveLength(1);
    expect(ws.runners.user).toBe(true);
    // Unlisted columns (and the raw relation) are not passed through.
    expect(ws.someFutureColumn).toBeUndefined();
    expect(ws.accountWorkspaces).toBeUndefined();
  });

  it('API-key listing carries no token/secret fields', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-a', teamId: 'team-a' });
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(createMockGetRequest({ Authorization: 'Bearer bld_test' }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expectNoSecrets(body);
    expect(JSON.parse(body).workspaces[0].id).toBe('ws-1');
  });

  it('a workspace without a webhook lists webhookConfig as null', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindMany.mockResolvedValue([{ ...SECRET_ROW, webhookConfig: null }]);
    const data = await (await GET(createMockGetRequest())).json();
    expect(data.workspaces[0].webhookConfig).toBeNull();
  });
});

describe('POST /api/workspaces', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkspacesInsert.mockReset();
    mockGetUserDefaultTeamId.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserDefaultTeamId.mockResolvedValue('team-1');
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    process.env.NODE_ENV = 'production';

    mockWorkspacesInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'ws-new', name: 'New Workspace' }]),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockPostRequest({ name: 'Test Workspace' });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing and no repoUrl', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockPostRequest({});
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Name is required');
  });

  it('creates workspace with name', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockPostRequest({ name: 'My Workspace' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('New Workspace');
  });

  it('auto-derives name from repoUrl', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createMockPostRequest({ repoUrl: 'https://github.com/user/my-repo.git' });
    const res = await POST(req);

    expect(res.status).toBe(200);
  });

  // ── Repo normalization on write ──────────────────────────────────────────
  //
  // See the PATCH cases in [id]/route.test.ts. The column filled up with
  // `https://github.com/owner/name`, and every consumer that built a GitHub
  // API path from it 404'd (PR #2125). Normalizing here keeps new rows clean.

  it('stores a pasted repo url as a canonical owner/name slug', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const valuesMock = mock(() => ({ returning: mock(() => [{ id: 'ws-new', name: 'my-repo' }]) }));
    mockWorkspacesInsert.mockReturnValue({ values: valuesMock });

    const req = createMockPostRequest({ repoUrl: 'https://github.com/user/my-repo.git' });
    await POST(req);

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'user/my-repo' }),
    );
  });

  it('keeps repo input it cannot parse instead of destroying it', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const valuesMock = mock(() => ({ returning: mock(() => [{ id: 'ws-new', name: 'x' }]) }));
    mockWorkspacesInsert.mockReturnValue({ values: valuesMock });

    const req = createMockPostRequest({ name: 'x', repoUrl: 'https://gitlab.com/user/my-repo' });
    await POST(req);

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'https://gitlab.com/user/my-repo' }),
    );
  });

  it('stores null, not an empty string, when no repo is given', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const valuesMock = mock(() => ({ returning: mock(() => [{ id: 'ws-new', name: 'x' }]) }));
    mockWorkspacesInsert.mockReturnValue({ values: valuesMock });

    const req = createMockPostRequest({ name: 'x' });
    await POST(req);

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ repo: null }));
  });

  it('persists defaultBranch to gitConfig.defaultBranch', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    const valuesMock = mock(() => ({ returning: mock(() => [{ id: 'ws-new', name: 'test-ws' }]) }));
    mockWorkspacesInsert.mockReturnValue({ values: valuesMock });

    const req = createMockPostRequest({ name: 'test-ws', repoUrl: 'owner/repo', defaultBranch: 'canary' });
    await POST(req);

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gitConfig: expect.objectContaining({ defaultBranch: 'canary' }),
      }),
    );
  });

  it('creates workspace with API key auth using API key team', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', type: 'service', teamId: 'team-api' });

    const req = new NextRequest('http://localhost:3000/api/workspaces', {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        'authorization': 'Bearer bld_testkey',
      }),
      body: JSON.stringify({ name: 'API Workspace' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
  });

  it('refuses to link an installation that does not belong to the workspace team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetInstallationOwnerTeamIds.mockImplementation(async () => ['team-other']);

    const res = await POST(createMockPostRequest({
      name: 'Linked',
      githubInstallationId: 'inst-other',
      githubRepo: { id: '1', repoId: '1', fullName: 'acme/app', name: 'app', owner: 'acme' },
    }));

    expect(res.status).toBe(403);
    expect(mockWorkspacesInsert).not.toHaveBeenCalled();
    expect(mockGetInstallationOwnerTeamIds).toHaveBeenCalledWith('inst-other');
  });

  it('links an installation that belongs to the workspace team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetInstallationOwnerTeamIds.mockImplementation(async () => ['team-1']);
    mockWorkspacesInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'ws-new', name: 'New Workspace' }]),
        onConflictDoUpdate: mock(() => ({ returning: mock(() => [{ id: 'repo-row-1' }]) })),
      })),
    });

    const res = await POST(createMockPostRequest({
      name: 'Linked',
      githubInstallationId: 'inst-1',
      githubRepo: { id: '1', repoId: '1', fullName: 'acme/app', name: 'app', owner: 'acme' },
    }));

    expect(res.status).toBe(200);
  });

  it('returns 401 when neither session nor API key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/workspaces', {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        'authorization': 'Bearer bld_invalid',
      }),
      body: JSON.stringify({ name: 'Should Fail' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });
});
