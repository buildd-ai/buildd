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
  id: '11111111-1111-4111-8111-111111111111',
  teamId: 'team1',
  workspaceId: null,
  slug: 'builder',
  name: 'Builder',
  isRole: true,
  content: 'You are Builder',
  allowedTools: [],
  mcpServers: {},
};

const OPERATOR_ROLE = {
  id: '33333333-3333-4333-8333-333333333333',
  teamId: 'team1',
  workspaceId: null,
  slug: 'operator',
  name: 'Platform Operator',
  isRole: true,
  content: 'You are the Operator',
  allowedTools: [],
  mcpServers: {},
};

const WS_ROLE = {
  id: '22222222-2222-4222-8222-222222222222',
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
    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111');
    const res = await GET(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 if role not found', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles/99999999-9999-4999-8999-999999999999');
    const res = await GET(req, { params: Promise.resolve({ id: '99999999-9999-4999-8999-999999999999' }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-UUID id without querying the db', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    const req = new NextRequest('http://localhost/api/roles/not-a-uuid');
    const res = await GET(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockWorkspaceSkillsFindFirst).not.toHaveBeenCalled();
  });

  it('returns team-level role when user belongs to that team', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(TEAM_ROLE));
    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111');
    const res = await GET(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skill.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(data.skill.workspaceId).toBeNull();
  });

  it('returns workspace role when user has access', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(WS_ROLE));
    const req = new NextRequest('http://localhost/api/roles/22222222-2222-4222-8222-222222222222');
    const res = await GET(req, { params: Promise.resolve({ id: '22222222-2222-4222-8222-222222222222' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skill.id).toBe('22222222-2222-4222-8222-222222222222');
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
    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New Name' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 if role not found', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles/99999999-9999-4999-8999-999999999999', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New Name' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: '99999999-9999-4999-8999-999999999999' }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-UUID id without querying the db', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    const req = new NextRequest('http://localhost/api/roles/not-a-uuid', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New Name' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(404);
    expect(mockWorkspaceSkillsFindFirst).not.toHaveBeenCalled();
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

    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Builder v2' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skill.name).toBe('Builder v2');
  });

  // role-routing.md §2: routing text is validated, never truncated, and lives
  // in metadata.routing next to the row's other metadata.
  it('rejects whenToUse outside 20–300 characters without writing', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(TEAM_ROLE));
    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ whenToUse: 'builder' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('whenToUse');
    expect(mockWorkspaceSkillsUpdate).not.toHaveBeenCalled();
  });

  it('writes whenToUse/notFor into metadata.routing, keeping other metadata', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve({ ...TEAM_ROLE, metadata: { defaultRoleVersion: 2 } }));
    const mockReturning = mock(() => Promise.resolve([TEAM_ROLE]));
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((_v: Record<string, unknown>) => ({ where: mockWhere }));
    mockWorkspaceSkillsUpdate.mockReturnValue({ set: mockSet });

    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ whenToUse: 'Code changes that end in a PR.', notFor: 'Research (Researcher)' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(200);
    const set = mockSet.mock.calls[0][0] as { metadata: Record<string, any> };
    expect(set.metadata.defaultRoleVersion).toBe(2);
    expect(set.metadata.routing).toMatchObject({ whenToUse: 'Code changes that end in a PR.', notFor: 'Research (Researcher)' });
    expect(typeof set.metadata.routing.updatedAt).toBe('string');
  });

  // docs/specs/agent-capabilities.md: only a role with a capability ceiling
  // (today, only 'operator') can hold metadata.operator at all.
  it('rejects an operatorGrant on a role with no capability ceiling, without writing', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(TEAM_ROLE));
    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: JSON.stringify({ operatorGrant: { enabled: true } }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('holds no agent capabilities');
    expect(mockWorkspaceSkillsUpdate).not.toHaveBeenCalled();
  });

  it('rejects a malformed operatorGrant on the operator role, without writing', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(OPERATOR_ROLE));
    const req = new NextRequest('http://localhost/api/roles/33333333-3333-4333-8333-333333333333', {
      method: 'PATCH',
      body: JSON.stringify({ operatorGrant: { capabilities: ['not-a-real-capability'] } }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Unknown capability');
    expect(mockWorkspaceSkillsUpdate).not.toHaveBeenCalled();
  });

  it('writes operatorGrant into metadata.operator on the operator role, keeping other metadata', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve({ ...OPERATOR_ROLE, metadata: { defaultRoleVersion: 1 } }));
    const mockReturning = mock(() => Promise.resolve([OPERATOR_ROLE]));
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((_v: Record<string, unknown>) => ({ where: mockWhere }));
    mockWorkspaceSkillsUpdate.mockReturnValue({ set: mockSet });

    const req = new NextRequest('http://localhost/api/roles/33333333-3333-4333-8333-333333333333', {
      method: 'PATCH',
      body: JSON.stringify({ operatorGrant: { enabled: false, capabilities: ['deployments:read'] } }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' }) });
    expect(res.status).toBe(200);
    const set = mockSet.mock.calls[0][0] as { metadata: Record<string, any> };
    expect(set.metadata.defaultRoleVersion).toBe(1);
    expect(set.metadata.operator).toEqual({ enabled: false, capabilities: ['deployments:read'] });
  });

  it('clears operatorGrant when the body sends operatorGrant: null', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve({ ...OPERATOR_ROLE, metadata: { operator: { enabled: true } } }));
    const mockReturning = mock(() => Promise.resolve([OPERATOR_ROLE]));
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((_v: Record<string, unknown>) => ({ where: mockWhere }));
    mockWorkspaceSkillsUpdate.mockReturnValue({ set: mockSet });

    const req = new NextRequest('http://localhost/api/roles/33333333-3333-4333-8333-333333333333', {
      method: 'PATCH',
      body: JSON.stringify({ operatorGrant: null }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' }) });
    expect(res.status).toBe(200);
    const set = mockSet.mock.calls[0][0] as { metadata: Record<string, any> };
    expect(set.metadata.operator).toBeUndefined();
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
    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-UUID id without querying the db', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    const req = new NextRequest('http://localhost/api/roles/not-a-uuid', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(404);
    expect(mockWorkspaceSkillsFindFirst).not.toHaveBeenCalled();
  });

  it('deletes a role and returns success', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(TEAM_ROLE));
    const mockWhere = mock(() => Promise.resolve());
    mockWorkspaceSkillsDelete.mockReturnValue({ where: mockWhere });
    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
