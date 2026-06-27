import { describe, it, expect, beforeEach, mock, afterAll} from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockGetWorkspaceRoles = mock(() => Promise.resolve([] as any[]));
const mockWorkspacesFindMany = mock(() => Promise.resolve([]));
const mockWorkspaceSkillsFindFirst = mock(() => null as any);
const mockWorkspaceSkillsInsert = mock(() => null as any);

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mock(() => Promise.resolve(null)),
}));

mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
  getUserTeamIds: mockGetUserTeamIds,
  getAccountWorkspacePermissions: mock(() => Promise.resolve([])),
}));

mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mock(() => Promise.resolve([])),
}));

mock.module('@/lib/mission-context', () => ({
  getWorkspaceRoles: mockGetWorkspaceRoles,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mock(() => null) },
      workspaces: { findMany: mockWorkspacesFindMany },
      workspaceSkills: { findFirst: mockWorkspaceSkillsFindFirst },
    },
    insert: mockWorkspaceSkillsInsert,
    update: mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) })),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ f, v }),
  and: (...c: any[]) => ({ c }),
  or: (...c: any[]) => ({ c }),
  isNull: (f: any) => ({ f }),
  inArray: (f: any, v: any) => ({ f, v }),
  desc: (f: any) => ({ f }),
  sql: Object.assign((s: any, ...v: any[]) => ({ s, v }), { empty: '' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id' },
  workspaces: { id: 'id', accessMode: 'accessMode' },
  workspaceSkills: {
    id: 'id', workspaceId: 'workspace_id', teamId: 'team_id',
    slug: 'slug', name: 'name', isRole: 'is_role', enabled: 'enabled', accountId: 'account_id',
  },
}));

mock.module('@/lib/storage', () => ({ isStorageConfigured: () => false }));
mock.module('@/lib/role-config', () => ({
  packageRoleConfig: mock(() => Promise.resolve({})),
  uploadRoleConfig: mock(() => Promise.resolve({ configHash: 'h', configStorageKey: 'k' })),
  deleteRoleConfig: mock(() => Promise.resolve()),
}));
mock.module('crypto', () => ({
  createHash: () => ({ update: () => ({ digest: () => 'fakehash' }) }),
}));

// Static imports after all mocks are registered
import { GET, POST } from './route';

describe('GET /api/roles', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockGetWorkspaceRoles.mockReset();
    mockWorkspacesFindMany.mockReset();
  });

  it('returns 401 if not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns empty roles when user has no workspaces', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve([]));
    const req = new NextRequest('http://localhost/api/roles');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.roles).toEqual([]);
  });

  it('returns deduplicated roles across workspaces', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1', 'ws2']));
    mockGetWorkspaceRoles
      .mockImplementationOnce(() => Promise.resolve([{ slug: 'builder', name: 'Builder', workspaceId: 'ws1' }]))
      .mockImplementationOnce(() => Promise.resolve([{ slug: 'builder', name: 'Builder', workspaceId: 'ws2' }]));
    const req = new NextRequest('http://localhost/api/roles');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.roles).toHaveLength(1);
  });
});

describe('POST /api/roles', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockWorkspaceSkillsInsert.mockReset();
  });

  it('returns 401 if not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Builder', content: 'You are Builder' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 if name missing', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    const req = new NextRequest('http://localhost/api/roles', {
      method: 'POST',
      body: JSON.stringify({ content: 'You are Builder' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 if content missing', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    const req = new NextRequest('http://localhost/api/roles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Builder' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 if user has no team', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve([]));
    const req = new NextRequest('http://localhost/api/roles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Builder', content: 'You are Builder' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 409 if team-level role with same slug already exists', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve({
      id: 'existing', teamId: 'team1', workspaceId: null, slug: 'builder',
    }));
    const req = new NextRequest('http://localhost/api/roles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Builder', content: 'You are Builder' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
  });

  it('creates a team-level role (workspaceId=null)', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(null)); // no existing
    const newRole = { id: 'r1', teamId: 'team1', workspaceId: null, slug: 'builder', name: 'Builder', isRole: true };
    const mockReturning = mock(() => Promise.resolve([newRole]));
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockWorkspaceSkillsInsert.mockReturnValue({ values: mockValues });

    const req = new NextRequest('http://localhost/api/roles', {
      method: 'POST',
      body: JSON.stringify({ name: 'Builder', content: 'You are Builder', isRole: true }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.skill.workspaceId).toBeNull();
    expect(data.skill.teamId).toBe('team1');
  });
});

afterAll(() => mock.restore());
