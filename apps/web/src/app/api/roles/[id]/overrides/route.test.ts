import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { roleHas } from '@/lib/permission-registry';

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

// The caller's role per team; `can` resolves through the real registry.
// Existing cases run as the team owner.
let teamRoles: Record<string, string> = { team1: 'owner' };
const mockCan = mock(async (caller: any, permission: any, teamId: string) =>
  caller.kind === 'user' && roleHas(teamRoles[teamId], permission, {}));
mock.module('@/lib/permissions', () => ({ can: mockCan }));

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
  id: '11111111-1111-4111-8111-111111111111',
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

const OPERATOR_TEAM_ROLE = { ...TEAM_ROLE, id: '33333333-3333-4333-8333-333333333333', slug: 'operator' };

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
    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(401);
  });

  it('returns 400 if workspaceId missing', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(TEAM_ROLE));
    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111/overrides', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 if team-level role not found', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(null));
    const req = new NextRequest('http://localhost/api/roles/99999999-9999-4999-8999-999999999999/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: '99999999-9999-4999-8999-999999999999' }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-UUID id without querying the db', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    const req = new NextRequest('http://localhost/api/roles/not-a-uuid/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(404);
    expect(mockWorkspaceSkillsFindFirst).not.toHaveBeenCalled();
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

    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1', allowedTools: ['Read'] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
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

    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1', allowedTools: ['Read', 'Write'] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skill.allowedTools).toEqual(['Read', 'Write']);
  });

  // docs/specs/agent-capabilities.md: a workspace's own opt-in, never
  // inherited from the team default row.
  it('rejects an operatorGrant on a role with no capability ceiling', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReturnValue(Promise.resolve(TEAM_ROLE));
    const req = new NextRequest('http://localhost/api/roles/11111111-1111-4111-8111-111111111111/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1', operatorGrant: { enabled: true } }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('holds no agent capabilities');
    expect(mockWorkspaceSkillsInsert).not.toHaveBeenCalled();
  });

  it('creates an override carrying the operator grant, never inherited from the team default', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockVerifyWorkspaceAccess.mockReturnValue(Promise.resolve(true));
    mockWorkspaceSkillsFindFirst
      .mockImplementationOnce(() => Promise.resolve(OPERATOR_TEAM_ROLE))
      .mockImplementationOnce(() => Promise.resolve(null));
    const overrideRow = {
      ...OPERATOR_TEAM_ROLE,
      id: 'override-op',
      workspaceId: 'ws1',
      metadata: { operator: { enabled: true, capabilities: ['deployments:read'] } },
    };
    const mockReturning = mock(() => Promise.resolve([overrideRow]));
    const mockValues = mock((v: Record<string, unknown>) => ({ returning: mockReturning, __values: v }));
    mockWorkspaceSkillsInsert.mockImplementation(() => ({ values: mockValues }));

    const req = new NextRequest('http://localhost/api/roles/33333333-3333-4333-8333-333333333333/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1', operatorGrant: { enabled: true, capabilities: ['deployments:read'] } }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' }) });
    expect(res.status).toBe(201);
    const insertedValues = mockValues.mock.calls[0][0] as { metadata: Record<string, any> };
    expect(insertedValues.metadata).toEqual({ operator: { enabled: true, capabilities: ['deployments:read'] } });
    const data = await res.json();
    expect(data.skill.metadata.operator).toEqual({ enabled: true, capabilities: ['deployments:read'] });
  });

  it('updates an existing override operatorGrant, preserving the rest of its metadata', async () => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockVerifyWorkspaceAccess.mockReturnValue(Promise.resolve(true));

    const existingOverride = {
      ...OPERATOR_TEAM_ROLE,
      id: 'override-op',
      workspaceId: 'ws1',
      metadata: { routing: { disabled: true }, operator: { enabled: false } },
    };
    mockWorkspaceSkillsFindFirst
      .mockImplementationOnce(() => Promise.resolve(OPERATOR_TEAM_ROLE))
      .mockImplementationOnce(() => Promise.resolve(existingOverride));

    const updatedOverride = { ...existingOverride, metadata: { routing: { disabled: true }, operator: { enabled: true, capabilities: ['deployments:write'] } } };
    const mockReturning = mock(() => Promise.resolve([updatedOverride]));
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((v: Record<string, unknown>) => ({ where: mockWhere, __values: v }));
    mockWorkspaceSkillsUpdate.mockImplementation(() => ({ set: mockSet }));

    const req = new NextRequest('http://localhost/api/roles/33333333-3333-4333-8333-333333333333/overrides', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws1', operatorGrant: { enabled: true, capabilities: ['deployments:write'] } }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' }) });
    expect(res.status).toBe(200);
    const setValues = mockSet.mock.calls[0][0] as { metadata: Record<string, any> };
    expect(setValues.metadata).toEqual({ routing: { disabled: true }, operator: { enabled: true, capabilities: ['deployments:write'] } });
  });
});

// manage_agent_roles (docs/specs/team-permissions.md)
describe('POST /api/roles/[id]/overrides: manage_agent_roles', () => {
  const ID = TEAM_ROLE.id;
  let values: ReturnType<typeof mock>;

  beforeEach(() => {
    mockGetCurrentUser.mockReturnValue(Promise.resolve({ id: 'user1' }));
    mockGetUserTeamIds.mockReturnValue(Promise.resolve(['team1']));
    mockGetUserWorkspaceIds.mockReturnValue(Promise.resolve(['ws1']));
    mockWorkspaceSkillsFindFirst.mockReset();
    mockWorkspaceSkillsFindFirst
      .mockImplementationOnce(() => Promise.resolve(TEAM_ROLE))
      .mockImplementationOnce(() => Promise.resolve(null));
    values = mock(() => ({ returning: mock(() => Promise.resolve([{ ...TEAM_ROLE, id: 'o1', workspaceId: 'ws1' }])) }));
    mockWorkspaceSkillsInsert.mockReset();
    mockWorkspaceSkillsInsert.mockReturnValue({ values });
    mockWorkspaceSkillsUpdate.mockReset();
  });

  const post = () => POST(new NextRequest(`http://localhost/api/roles/${ID}/overrides`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId: 'ws1', allowedTools: ['Read'] }),
  }), { params: Promise.resolve({ id: ID }) });

  it('refuses a team member and writes nothing', async () => {
    teamRoles = { team1: 'member' };
    const res = await post();
    expect(res.status).toBe(403);
    expect(values).not.toHaveBeenCalled();
    expect(mockWorkspaceSkillsUpdate).not.toHaveBeenCalled();
    expect(mockCan).toHaveBeenCalledWith({ kind: 'user', userId: 'user1' }, 'manage_agent_roles', 'team1');
  });

  for (const role of ['owner', 'admin']) {
    it(`lets a team ${role} write an override`, async () => {
      teamRoles = { team1: role };
      const res = await post();
      expect(res.status).toBe(201);
      expect(values).toHaveBeenCalledTimes(1);
    });
  }
});
