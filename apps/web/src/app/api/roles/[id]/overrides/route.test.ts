import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockWorkspaceSkillsFindFirst = mock(() => null as any);
const mockWorkspaceSkillsInsert = mock(() => null as any);
const mockWorkspaceSkillsUpdate = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(false));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mock(() => Promise.resolve(false)),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaceSkills: { findFirst: mockWorkspaceSkillsFindFirst },
    },
    insert: mockWorkspaceSkillsInsert,
    update: mockWorkspaceSkillsUpdate,
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

// Import handler AFTER mocks
import { POST } from './route';

const TEAM_ROLE = {
  id: 'role1',
  teamId: 'team1',
  workspaceId: null,
  slug: 'builder',
  name: 'Builder',
  isRole: true,
  content: 'You are Builder',
  contentHash: 'oldhash',
  allowedTools: [],
  mcpServers: {},
  requiredEnvVars: {},
  model: 'inherit',
  color: '#8A8478',
  description: null,
  canDelegateTo: [],
  background: false,
  maxTurns: null,
  enabled: true,
  repoUrl: null,
  defaultBackend: null,
};

describe('POST /api/roles/[id]/overrides', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockWorkspaceSkillsInsert.mockReset();
    mockWorkspaceSkillsUpdate.mockReset();
  });

  it('returns 401 if not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles/role1/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'role1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 400 if workspaceId missing', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(TEAM_ROLE));
    const req = new NextRequest('http://localhost/api/roles/role1/overrides', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'role1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 if team-level role not found', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles/unknown/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('creates a workspace override inheriting from team default', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockVerifyWorkspaceAccess.mockReturnValue(Promise.resolve(true));
    // First call: find the team-level role; second call: no existing override
    mockWorkspaceSkillsFindFirst
      .mockImplementationOnce(() => Promise.resolve(TEAM_ROLE))
      .mockImplementationOnce(() => Promise.resolve(null));
    const overrideRow = {
      ...TEAM_ROLE,
      id: 'override1',
      workspaceId: 'ws1',
      allowedTools: ['Read'],
    };
    const mockReturning = mock(() => Promise.resolve([overrideRow]));
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockWorkspaceSkillsInsert.mockReturnValue({ values: mockValues });

    const req = new NextRequest('http://localhost/api/roles/role1/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1', allowedTools: ['Read'] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'role1' }) });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.skill.workspaceId).toBe('ws1');
    expect(data.skill.allowedTools).toEqual(['Read']);
  });

  it('updates existing workspace override without changing inherited fields', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockVerifyWorkspaceAccess.mockReturnValue(Promise.resolve(true));

    const existingOverride = {
      ...TEAM_ROLE,
      id: 'override1',
      workspaceId: 'ws1',
      allowedTools: ['Read'],
    };

    // First call: team-level role; second call: existing override
    mockWorkspaceSkillsFindFirst
      .mockImplementationOnce(() => Promise.resolve(TEAM_ROLE))
      .mockImplementationOnce(() => Promise.resolve(existingOverride));

    const updatedOverride = { ...existingOverride, allowedTools: ['Read', 'Write'] };
    const mockReturning = mock(() => Promise.resolve([updatedOverride]));
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockWorkspaceSkillsUpdate.mockReturnValue({ set: mockSet });

    const req = new NextRequest('http://localhost/api/roles/role1/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1', allowedTools: ['Read', 'Write'] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'role1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skill.allowedTools).toEqual(['Read', 'Write']);
  });
});
