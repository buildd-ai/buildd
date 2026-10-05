import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { TOKEN_SCOPES } from '@buildd/core/token-scopes';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockGetUserDefaultTeamId = mock(() => Promise.resolve('team-1'));
const mockGetUserTeamRole = mock(() => Promise.resolve('owner' as string | null));
const mockAccountsFindMany = mock(() => [] as any[]);
const mockAccountsInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'account-new', name: 'New Account', apiKey: 'hashed' }]),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserDefaultTeamId: mockGetUserDefaultTeamId,
  getUserTeamRole: mockGetUserTeamRole,
}));

mock.module('@/lib/api-auth', () => ({
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

const accountWorkspacesTable = { table: 'accountWorkspaces' };
let teamWorkspaceRows: Array<{ id: string; teamId: string; accessMode: string }> = [];
const linkedWorkspaceIds: string[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => null },
      accounts: { findMany: mockAccountsFindMany },
      workspaces: { findMany: mock(() => Promise.resolve(teamWorkspaceRows)) },
    },
    insert: (table: unknown) => table === accountWorkspacesTable
      ? { values: (v: { workspaceId: string }) => { linkedWorkspaceIds.push(v.workspaceId); return Promise.resolve(); } }
      : mockAccountsInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({ teams: { id: 'teams.id', permissionOverrides: 'teams.permission_overrides' },
  accounts: { teamId: 'teamId', createdAt: 'createdAt' },
  accountWorkspaces: accountWorkspacesTable,
  workspaces: {teamId: "teamId"},
}));

const mockSetOAuthToken = mock(() => Promise.resolve());
mock.module('@buildd/core/secrets', () => ({
  setOAuthToken: mockSetOAuthToken,
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, POST } from './route';

describe('GET /api/accounts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindMany.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserDefaultTeamId.mockReset();
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserDefaultTeamId.mockResolvedValue('team-1');
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts');
    const res = await GET();

    expect(res.status).toBe(401);
  });

  it('returns accounts for authenticated user', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindMany.mockResolvedValue([
      { id: 'acc-1', name: 'My Runner', type: 'user' },
      { id: 'acc-2', name: 'Service', type: 'service' },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accounts).toHaveLength(2);
  });
});

describe('POST /api/accounts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsInsert.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserDefaultTeamId.mockReset();
    mockSetOAuthToken.mockReset();
    mockGetUserTeamRole.mockReset();
    mockGetUserTeamRole.mockResolvedValue('owner');
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserDefaultTeamId.mockResolvedValue('team-1');
    process.env.NODE_ENV = 'production';

    mockAccountsInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'account-new', name: 'New Account', apiKey: 'hashed' }]),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Test', type: 'user' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 400 when name or type missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Test' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Name and type are required');
  });

  it('creates account and returns plaintext key', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'My Runner', type: 'user' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Should return plaintext key (starts with bld_)
    expect(data.apiKey).toBeDefined();
  });

  it('does not write oauthToken to accounts table or secrets when provided', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    let capturedValues: any;
    mockAccountsInsert.mockReturnValue({
      values: mock((vals: any) => {
        capturedValues = vals;
        return {
          returning: mock(() => [{ id: 'account-new', name: 'OAuth Account', apiKey: 'hashed' }]),
        };
      }),
    });

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'OAuth Account', type: 'user', authType: 'oauth', oauthToken: 'secret-token' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    // oauthToken must not be written to the accounts column
    expect(capturedValues?.oauthToken).toBeUndefined();
    // setOAuthToken must not be called — credentials belong in Agent Backends, not here
    expect((mockSetOAuthToken as Mock<any>).mock.calls.length).toBe(0);
  });
});

describe("POST /api/accounts — key level is capped by the creator's team role", () => {
  let capturedValues: any;

  function createReq(body: Record<string, unknown>) {
    return new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Key', type: 'service', authType: 'api', ...body }),
    });
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    capturedValues = undefined;
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockReset();
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserDefaultTeamId.mockReset();
    mockGetUserDefaultTeamId.mockResolvedValue('team-1');
    mockGetUserTeamRole.mockReset();
    mockAccountsInsert.mockReset();
    mockAccountsInsert.mockReturnValue({
      values: mock((vals: any) => {
        capturedValues = vals;
        return { returning: mock(() => [{ id: 'account-new', name: 'Key', apiKey: 'hashed' }]) };
      }),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('refuses an admin-level key for a team member with 403 and creates nothing', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await POST(createReq({ level: 'admin' }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain('worker');
    expect(capturedValues).toBeUndefined();
  });

  it('lets a team member create a worker-level key', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await POST(createReq({ level: 'worker' }));
    expect(res.status).toBe(200);
    expect(capturedValues.level).toBe('worker');
  });

  it('lets a team admin create an admin-level key', async () => {
    mockGetUserTeamRole.mockResolvedValue('admin');
    const res = await POST(createReq({ level: 'admin' }));
    expect(res.status).toBe(200);
    expect(capturedValues.level).toBe('admin');
  });

  it('defaults to worker level when none is requested', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await POST(createReq({}));
    expect(res.status).toBe(200);
    expect(capturedValues.level).toBe('worker');
  });

  it('rejects an unknown level with 400', async () => {
    mockGetUserTeamRole.mockResolvedValue('owner');
    const res = await POST(createReq({ level: 'superuser' }));
    expect(res.status).toBe(400);
    expect(capturedValues).toBeUndefined();
  });

  it('checks the role on the team the key is created in', async () => {
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    mockGetUserTeamRole.mockImplementation(async (_u: string, teamId: string) =>
      teamId === 'team-2' ? 'member' : 'owner');
    const res = await POST(createReq({ level: 'admin', teamId: 'team-2' }));
    expect(res.status).toBe(403);
    expect(mockGetUserTeamRole).toHaveBeenCalledWith('user-1', 'team-2');
  });
});

describe('POST scoped tokens', () => {
  beforeEach(() => { process.env.NODE_ENV = 'production'; mockGetCurrentUser.mockResolvedValue({id:'user-1'}); mockGetUserTeamRole.mockResolvedValue('owner'); mockGetUserDefaultTeamId.mockResolvedValue('team-1'); });
  const req = (fields: object) => new NextRequest('http://localhost/api/accounts', {method:'POST',body:JSON.stringify({name:'Scoped',type:'service',authType:'api',...fields})});
  it('rejects unknown scopes', async () => { expect((await POST(req({scopes:['invented']}))).status).toBe(400); });
  it('rejects expired creation dates', async () => { expect((await POST(req({scopes:['analytics:read'],expiresAt:'2000-01-01'}))).status).toBe(400); });
  it('refuses admin scopes for members', async () => { mockGetUserTeamRole.mockResolvedValue('member'); expect((await POST(req({scopes:['secrets']}))).status).toBe(403); });
});

it('persists analytics scope without requiring admin level', async () => {
  process.env.NODE_ENV='production'; mockGetCurrentUser.mockResolvedValue({id:'creator'}); mockGetUserDefaultTeamId.mockResolvedValue('team-1'); mockGetUserTeamRole.mockResolvedValue('member');
  let inserted: any;
  mockAccountsInsert.mockReturnValue({values:mock((values:any) => {inserted=values;return {returning:mock(() => [{id:'created',...values}])};})});
  const expiry = new Date(Date.now()+86400000).toISOString();
  const response = await POST(new NextRequest('http://localhost/api/accounts',{method:'POST',body:JSON.stringify({name:'Analytics',type:'service',authType:'api',scopes:['analytics:read'],expiresAt:expiry})}));
  expect(response.status).toBe(200); expect(inserted.scopes).toEqual(['analytics:read']); expect(inserted.level).toBe('worker'); expect(inserted.expiresAt.toISOString()).toBe(expiry);
});

describe('POST scoped tokens: level, workspace links and role ceilings', () => {
  const req = (fields: object) => new NextRequest('http://localhost/api/accounts', { method: 'POST', body: JSON.stringify({ name: 'Scoped', type: 'service', authType: 'api', ...fields }) });
  let inserted: any;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserDefaultTeamId.mockResolvedValue('team-1');
    mockGetUserTeamRole.mockResolvedValue('owner');
    teamWorkspaceRows = [{ id: 'ws-open', teamId: 'team-1', accessMode: 'open' }, { id: 'ws-restricted', teamId: 'team-1', accessMode: 'restricted' }];
    linkedWorkspaceIds.length = 0;
    inserted = undefined;
    mockAccountsInsert.mockReturnValue({ values: mock((values: any) => { inserted = values; return { returning: mock(() => [{ id: 'created', ...values }]) }; }) });
  });

  it('derives the stored level from the scopes', async () => {
    expect((await POST(req({ scopes: ['tasks:write'] }))).status).toBe(200);
    expect(inserted.level).toBe('worker');
    expect((await POST(req({ scopes: ['admin'] }))).status).toBe(200);
    expect(inserted.level).toBe('admin');
  });

  it('rejects a level that disagrees with the scopes, and empty scopes', async () => {
    expect((await POST(req({ scopes: ['analytics:read'], level: 'admin' }))).status).toBe(400);
    expect((await POST(req({ scopes: ['admin'], level: 'worker' }))).status).toBe(400);
    expect((await POST(req({ scopes: [] }))).status).toBe(400);
    expect(inserted).toBeUndefined();
  });

  it('an unrestricted token is never auto-linked into a restricted workspace', async () => {
    expect((await POST(req({ scopes: ['tasks:read'] }))).status).toBe(200);
    expect(linkedWorkspaceIds).toEqual(['ws-open']);
  });

  it('a member cannot link a token into a restricted workspace; an owner can, explicitly', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    expect((await POST(req({ scopes: ['tasks:read'], workspaceIds: ['ws-restricted'] }))).status).toBe(403);
    expect(inserted).toBeUndefined();
    mockGetUserTeamRole.mockResolvedValue('owner');
    expect((await POST(req({ scopes: ['tasks:read'], workspaceIds: ['ws-restricted'] }))).status).toBe(200);
    expect(linkedWorkspaceIds).toEqual(['ws-restricted']);
  });

  it('a legacy workspaceId link gets the same team and restricted-mode checks', async () => {
    expect((await POST(req({ workspaceId: 'ws-elsewhere' }))).status).toBe(403);
    mockGetUserTeamRole.mockResolvedValue('member');
    expect((await POST(req({ workspaceId: 'ws-restricted' }))).status).toBe(403);
    expect(inserted).toBeUndefined();
    expect((await POST(req({ workspaceId: 'ws-open' }))).status).toBe(200);
    expect(linkedWorkspaceIds).toEqual(['ws-open']);
    mockGetUserTeamRole.mockResolvedValue('owner');
    linkedWorkspaceIds.length = 0;
    expect((await POST(req({ workspaceId: 'ws-restricted' }))).status).toBe(200);
    expect(linkedWorkspaceIds).toEqual(['ws-restricted']);
  });

  it('dedupes workspace ids and validates them all before creating anything', async () => {
    expect((await POST(req({ scopes: ['tasks:read'], workspaceIds: ['ws-open', 'ws-open'] }))).status).toBe(200);
    expect(inserted.workspaceIds).toEqual(['ws-open']);
    expect(linkedWorkspaceIds).toEqual(['ws-open']);
    inserted = undefined;
    expect((await POST(req({ scopes: ['tasks:read'], workspaceIds: ['ws-open', 'ws-elsewhere'] }))).status).toBe(403);
    expect((await POST(req({ scopes: ['tasks:read'], workspaceIds: [] }))).status).toBe(400);
    expect(inserted).toBeUndefined();
  });

  it('a member cannot mint a token that passes any administrative gate', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    for (const scope of TOKEN_SCOPES) {
      inserted = undefined;
      await POST(req({ scopes: [scope] }));
      if (!inserted) continue; // refused outright
      const token = { level: inserted.level, scopes: inserted.scopes, workspaceIds: inserted.workspaceIds };
      const gates: Array<[string, string, Parameters<typeof hasTokenRouteAdminAccess>[2]]> = [
        ['/api/github/pr', 'PUT', 'admin'], ['/api/workers/claim', 'POST', 'admin'],
        ['/api/tasks/bulk', 'POST', 'tasks:admin'], ['/api/tasks/cleanup', 'POST', 'tasks:admin'],
        ['/api/tasks/t1/attach-pr', 'POST', 'tasks:admin'], ['/api/tasks/t1', 'PATCH', 'tasks:admin'],
        ['/api/discrepancies/d1/dispatch-doc-fix', 'POST', 'missions:admin'],
        ['/api/knowledge/ingest-jobs', 'POST', 'knowledge:admin'],
        ['/api/workers/w1/activity', 'POST', 'workers:admin'], ['/api/tasks/t1/messages', 'GET', 'workers:admin'],
        ['/api/workers/w1/instruct', 'POST', undefined], ['/api/missions', 'POST', undefined],
        ['/api/workspaces/ws-open/skills', 'POST', undefined], ['/api/secrets', 'POST', undefined],
      ];
      for (const [path, method, capability] of gates) {
        expect(hasTokenRouteAdminAccess(token, { url: `https://example.test${path}`, method }, capability)).toBe(false);
      }
      expect(token.level).not.toBe('admin');
    }
  });
});
