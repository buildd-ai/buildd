import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockWorkspaceSkillsFindFirst = mock(() => null as any);
const mockWorkspaceSkillsUpdate = mock(() => null as any);
const mockWorkspaceSkillsDelete = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
  verifyWorkspaceAccess: mock(() => Promise.resolve(false)),
  verifyAccountWorkspaceAccess: mock(() => Promise.resolve(false)),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaceSkills: { findFirst: mockWorkspaceSkillsFindFirst },
    },
    update: mockWorkspaceSkillsUpdate,
    delete: mockWorkspaceSkillsDelete,
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  or: (...conditions: any[]) => ({ conditions, type: 'or' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
    { empty: '' }
  ),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaceSkills: {
    id: 'id',
    workspaceId: 'workspace_id',
    teamId: 'team_id',
    slug: 'slug',
    name: 'name',
    isRole: 'is_role',
    enabled: 'enabled',
  },
}));

mock.module('@/lib/storage', () => ({
  isStorageConfigured: () => false,
}));

mock.module('@/lib/role-config', () => ({
  packageRoleConfig: mock(() => Promise.resolve({ configHash: 'hash', buffer: Buffer.from('') })),
  uploadRoleConfig: mock(() => Promise.resolve({ configHash: 'hash', configStorageKey: 'key' })),
  deleteRoleConfig: mock(() => Promise.resolve()),
}));

mock.module('crypto', () => ({
  createHash: () => ({
    update: () => ({ digest: () => 'fakehash' }),
  }),
}));

// Import handlers AFTER mocks
import { GET, PATCH, DELETE } from './route';

const TEAM_ROLE = {
  id: 'role1',
  teamId: 'team1',
  workspaceId: null,
  slug: 'builder',
  name: 'Builder',
  isRole: true,
  content: 'You are Builder',
  allowedTools: [],
  mcpServers: {},
};

const WS_ROLE = {
  id: 'role2',
  teamId: 'team1',
  workspaceId: 'ws1',
  slug: 'builder',
  name: 'Builder Override',
  isRole: true,
  content: 'Custom content',
  allowedTools: ['Read'],
  mcpServers: {},
};

describe('GET /api/roles/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
  });

  it('returns 401 if not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles/role1');
    const res = await GET(req, { params: Promise.resolve({ id: 'role1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 if role not found', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles/unknown');
    const res = await GET(req, { params: Promise.resolve({ id: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns team-level role when user belongs to that team', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(TEAM_ROLE));
    const req = new NextRequest('http://localhost/api/roles/role1');
    const res = await GET(req, { params: Promise.resolve({ id: 'role1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skill.id).toBe('role1');
    expect(data.skill.workspaceId).toBeNull();
  });

  it('returns workspace role when user has access', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(WS_ROLE));
    const req = new NextRequest('http://localhost/api/roles/role2');
    const res = await GET(req, { params: Promise.resolve({ id: 'role2' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skill.id).toBe('role2');
  });
});

describe('PATCH /api/roles/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockWorkspaceSkillsUpdate.mockReset();
  });

  it('returns 401 if not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles/role1', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New Name' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'role1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 if role not found', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles/unknown', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New Name' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('updates a team-level role successfully', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(TEAM_ROLE));
    const updatedRole = { ...TEAM_ROLE, name: 'Builder v2' };
    const mockReturning = mock(() => Promise.resolve([updatedRole]));
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockWorkspaceSkillsUpdate.mockReturnValue({ set: mockSet });

    const req = new NextRequest('http://localhost/api/roles/role1', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Builder v2' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'role1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skill.name).toBe('Builder v2');
  });
});

describe('DELETE /api/roles/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockWorkspaceSkillsDelete.mockReset();
  });

  it('returns 401 if not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles/role1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'role1' }) });
    expect(res.status).toBe(401);
  });

  it('deletes a role and returns success', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(TEAM_ROLE));
    const mockWhere = mock(() => Promise.resolve());
    mockWorkspaceSkillsDelete.mockReturnValue({ where: mockWhere });
    const req = new NextRequest('http://localhost/api/roles/role1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'role1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
