import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkspaceSkillsFindFirst = mock(() => null as any);
const mockSkillsUpdate = mock(() => null as any);
const mockSkillsDelete = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(false));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));
const mockConnectorsFindMany = mock(() => Promise.resolve([] as any[]));
const mockConnectorWorkspacesFindMany = mock(() => Promise.resolve([] as any[]));

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock storage + role-config (prevent aws-sdk resolution in test env)
mock.module('@/lib/storage', () => ({
  isStorageConfigured: () => false,
}));

mock.module('@/lib/role-config', () => ({
  packageRoleConfig: mock(() => Promise.resolve({})),
  uploadRoleConfig: mock(() => Promise.resolve({ configHash: 'hash', configStorageKey: 'key' })),
  deleteRoleConfig: mock(() => Promise.resolve()),
}));

// Mock api-auth — uses authenticateApiKey (handles both bld_* keys and OAuth JWTs)
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaceSkills: { findFirst: mockWorkspaceSkillsFindFirst },
      connectors: { findMany: mockConnectorsFindMany },
      connectorWorkspaces: { findMany: mockConnectorWorkspacesFindMany },
    },
    update: mockSkillsUpdate,
    delete: mockSkillsDelete,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  inArray: (field: any, values: any) => ({ field, values, type: 'inArray' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  workspaceSkills: {
    id: 'id',
    workspaceId: 'workspaceId',
  },
  connectors: { id: 'id', workspaceScoped: 'workspaceScoped' },
  connectorWorkspaces: { connectorId: 'connectorId', workspaceId: 'workspaceId', enabled: 'enabled' },
}));

// Import handlers AFTER mocks
import { GET, PATCH, DELETE } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body } = options;

  const url = 'http://localhost:3000/api/workspaces/ws-1/skills/skill-1';

  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };

  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }

  return new NextRequest(url, init);
}

// Shared account fixtures
const adminAccount = { id: 'account-123', level: 'admin' as const, teamId: 'team-123' };
const workerAccount = { id: 'account-456', level: 'worker' as const, teamId: 'team-123' };
const triggerAccount = { id: 'account-789', level: 'trigger' as const, teamId: 'team-123' };

describe('GET /api/workspaces/[id]/skills/[skillId]', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const request = createMockRequest();
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 when worker-level token is used', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(workerAccount);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_worker' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 when trigger-level token is used', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(triggerAccount);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_trigger' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns skill for valid request with session auth', async () => {
    const mockSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      slug: 'test-skill',
      content: '# Test',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(mockSkill);

    const request = createMockRequest();
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.id).toBe('skill-1');
    expect(data.skill.name).toBe('Test Skill');
  });

  it('returns skill for admin API key auth', async () => {
    const mockSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      slug: 'test-skill',
      content: '# Test',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(mockSkill);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_admin_xxx' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.id).toBe('skill-1');
  });

  it('returns skill for OAuth JWT (admin-level connector token)', async () => {
    const mockSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      slug: 'test-skill',
      content: '# Test',
      enabled: true,
    };

    // OAuth JWTs are always resolved as admin by authenticateApiKey
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(mockSkill);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fake.jwt' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.id).toBe('skill-1');
  });

  it('returns 404 when skill not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-999' });
    const response = await GET(request, { params });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Skill not found');
  });

  it('returns 404 when workspace access denied for session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const request = createMockRequest();
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 404 when workspace access denied for admin API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_admin_xxx' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });
});

describe('PATCH /api/workspaces/[id]/skills/[skillId]', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockSkillsUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockConnectorsFindMany.mockReset();
    mockConnectorWorkspacesFindMany.mockReset();
    mockConnectorsFindMany.mockResolvedValue([]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated Name' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 when worker-level token attempts to update skill', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(workerAccount);

    const request = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_worker' },
      body: { name: 'Updated Name' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 when trigger-level token attempts to update skill', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(triggerAccount);

    const request = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_trigger' },
      body: { name: 'Updated Name' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('updates skill fields (session auth)', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Old Name',
      content: '# Old',
      enabled: true,
    };

    const updatedSkill = {
      ...existingSkill,
      name: 'Updated Name',
      description: 'New description',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockReturning = mock(() => [updatedSkill]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockSkillsUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated Name', description: 'New description' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.name).toBe('Updated Name');
  });

  it('updates skill via admin API key auth', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Old Name',
      enabled: true,
    };

    const updatedSkill = {
      ...existingSkill,
      name: 'Updated Name',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockReturning = mock(() => [updatedSkill]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockSkillsUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_admin_xxx' },
      body: { name: 'Updated Name' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.name).toBe('Updated Name');
  });

  it('updates skill via OAuth JWT (admin-level connector token)', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Builder Role',
      content: '# Old content',
      enabled: true,
    };

    const updatedSkill = {
      ...existingSkill,
      content: '# Updated content',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockReturning = mock(() => [updatedSkill]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockSkillsUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fake.jwt' },
      body: { content: '# Updated content' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.content).toBe('# Updated content');
  });

  it('recomputes hash when content changes', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      content: '# Old',
      contentHash: 'old-hash',
      enabled: true,
    };

    const updatedSkill = {
      ...existingSkill,
      content: '# New',
      contentHash: expect.any(String),
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    let capturedUpdates: any = null;
    const mockReturning = mock(() => [updatedSkill]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((updates: any) => {
      capturedUpdates = updates;
      return { where: mockWhere };
    });
    mockSkillsUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { content: '# New' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(200);
    expect(capturedUpdates.content).toBe('# New');
    expect(capturedUpdates.contentHash).toBeDefined();
    expect(capturedUpdates.contentHash).not.toBe('old-hash');
  });

  it('persists connectorRefs on PATCH (spec §2)', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Builder',
      slug: 'builder',
      content: '# Builder',
      isRole: true,
      connectorRefs: [],
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    let capturedUpdates: any = null;
    const mockReturning = mock(() => [{ ...existingSkill, connectorRefs: ['conn-1', 'conn-2'] }]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((updates: any) => {
      capturedUpdates = updates;
      return { where: mockWhere };
    });
    mockSkillsUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { connectorRefs: ['conn-1', 'conn-2'] },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(200);
    expect(capturedUpdates.connectorRefs).toEqual(['conn-1', 'conn-2']);
    const data = await response.json();
    expect(data.skill.connectorRefs).toEqual(['conn-1', 'conn-2']);
  });

  // Unified-sharing Phase 2: reject mounting a connector workspace-scoped to a
  // DIFFERENT workspace than this role's (no enabled mount row for ws-1).
  it('returns 400 connector_out_of_scope when a workspace-scoped connector is not in scope', async () => {
    const existingSkill = {
      id: 'skill-1', workspaceId: 'ws-1', name: 'Builder', slug: 'builder',
      content: '# Builder', isRole: true, connectorRefs: [], enabled: true,
    };
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);
    // conn-1 is workspace-scoped, and has NO enabled mount row for ws-1.
    mockConnectorsFindMany.mockResolvedValue([{ id: 'conn-1', workspaceScoped: true }]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);

    const request = createMockRequest({ method: 'PATCH', body: { connectorRefs: ['conn-1'] } });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('connector_out_of_scope');
    expect(data.connectorIds).toEqual(['conn-1']);
  });

  // A workspace-scoped connector WITH an enabled mount row for this workspace is allowed.
  it('allows a workspace-scoped connector when it is enabled for this workspace', async () => {
    const existingSkill = {
      id: 'skill-1', workspaceId: 'ws-1', name: 'Builder', slug: 'builder',
      content: '# Builder', isRole: true, connectorRefs: [], enabled: true,
    };
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);
    mockConnectorsFindMany.mockResolvedValue([{ id: 'conn-1', workspaceScoped: true }]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([{ connectorId: 'conn-1', enabled: true }]);

    const mockReturning = mock(() => [{ ...existingSkill, connectorRefs: ['conn-1'] }]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockSkillsUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({ method: 'PATCH', body: { connectorRefs: ['conn-1'] } });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.connectorRefs).toEqual(['conn-1']);
  });

  it('returns 404 when skill not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated Name' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-999' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Skill not found');
  });

  it('updates enabled field', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      enabled: true,
    };

    const updatedSkill = {
      ...existingSkill,
      enabled: false,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockReturning = mock(() => [updatedSkill]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockSkillsUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { enabled: false },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.enabled).toBe(false);
  });

  it('returns 404 when workspace access denied', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const request = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated Name' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });
});

describe('DELETE /api/workspaces/[id]/skills/[skillId]', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockSkillsDelete.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'DELETE',
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await DELETE(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 when worker-level token attempts to delete skill', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(workerAccount);

    const request = createMockRequest({
      method: 'DELETE',
      headers: { Authorization: 'Bearer bld_worker' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await DELETE(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('deletes skill successfully (session auth)', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockWhere = mock(() => Promise.resolve());
    mockSkillsDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({
      method: 'DELETE',
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await DELETE(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('deletes skill via admin API key auth', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockWhere = mock(() => Promise.resolve());
    mockSkillsDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({
      method: 'DELETE',
      headers: { Authorization: 'Bearer bld_admin_xxx' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await DELETE(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('deletes skill via OAuth JWT (admin-level connector token)', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockWhere = mock(() => Promise.resolve());
    mockSkillsDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({
      method: 'DELETE',
      headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fake.jwt' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await DELETE(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('returns 404 when skill not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'DELETE',
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-999' });
    const response = await DELETE(request, { params });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Skill not found');
  });

  it('returns 404 when workspace access denied', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const request = createMockRequest({
      method: 'DELETE',
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await DELETE(request, { params });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });
});
