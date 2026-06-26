import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspaceSkillsFindFirst = mock(() => null as any);
const mockSkillsSelect = mock(() => null as any);
const mockSkillsInsert = mock(() => null as any);
const mockSkillsUpdate = mock(() => null as any);
const mockExecute = mock(() => Promise.resolve({ rows: [] }));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(false));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));

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
      workspaces: { findFirst: mockWorkspacesFindFirst },
      workspaceSkills: { findFirst: mockWorkspaceSkillsFindFirst },
    },
    select: mockSkillsSelect,
    insert: mockSkillsInsert,
    update: mockSkillsUpdate,
    execute: mockExecute,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }), { empty: '' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id' },
  workspaceSkills: {
    id: 'id',
    workspaceId: 'workspaceId',
    slug: 'slug',
    createdAt: 'createdAt',
    enabled: 'enabled',
  },
}));

// Import handlers AFTER mocks
import { GET, POST } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  searchParams?: Record<string, string>;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body, searchParams = {} } = options;

  let url = 'http://localhost:3000/api/workspaces/ws-1/skills';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) {
    url += `?${params.toString()}`;
  }

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

// Shared admin account fixture
const adminAccount = { id: 'account-123', level: 'admin' as const, teamId: 'team-123' };
const workerAccount = { id: 'account-456', level: 'worker' as const, teamId: 'team-123' };
const triggerAccount = { id: 'account-789', level: 'trigger' as const, teamId: 'team-123' };

describe('GET /api/workspaces/[id]/skills', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockSkillsSelect.mockReset();
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ rows: [] });
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const request = createMockRequest();
    const params = Promise.resolve({ id: 'ws-1' });
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
    const params = Promise.resolve({ id: 'ws-1' });
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
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns skills list for admin API key auth', async () => {
    const mockSkills = [
      { id: 'skill-1', workspaceId: 'ws-1', name: 'Skill 1', slug: 'skill-1', enabled: true },
      { id: 'skill-2', workspaceId: 'ws-1', name: 'Skill 2', slug: 'skill-2', enabled: true },
    ];

    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);

    const mockWhere = mock(() => ({
      orderBy: mock(() => Promise.resolve(mockSkills)),
    }));
    const mockFrom = mock(() => ({ where: mockWhere }));
    mockSkillsSelect.mockReturnValue({ from: mockFrom });

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_admin_xxx' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skills).toHaveLength(2);
    expect(data.skills[0].id).toBe('skill-1');
  });

  it('returns skills list for OAuth JWT (admin-level token)', async () => {
    const mockSkills = [
      { id: 'skill-1', workspaceId: 'ws-1', name: 'Skill 1', slug: 'skill-1', enabled: true },
    ];

    // OAuth JWTs are always resolved as admin by authenticateApiKey
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);

    const mockWhere = mock(() => ({
      orderBy: mock(() => Promise.resolve(mockSkills)),
    }));
    const mockFrom = mock(() => ({ where: mockWhere }));
    mockSkillsSelect.mockReturnValue({ from: mockFrom });

    // Simulate a JWT bearer (authenticateApiKey handles the JWT path)
    const request = createMockRequest({
      headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fake.jwt' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skills).toHaveLength(1);
  });

  it('returns skills list for session auth', async () => {
    const mockSkills = [
      { id: 'skill-1', workspaceId: 'ws-1', name: 'Skill 1', slug: 'skill-1', enabled: true },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);

    const mockWhere = mock(() => ({
      orderBy: mock(() => Promise.resolve(mockSkills)),
    }));
    const mockFrom = mock(() => ({ where: mockWhere }));
    mockSkillsSelect.mockReturnValue({ from: mockFrom });

    const request = createMockRequest();
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skills).toHaveLength(1);
  });

  it('filters by enabled=true', async () => {
    const mockSkills = [
      { id: 'skill-1', workspaceId: 'ws-1', name: 'Skill 1', slug: 'skill-1', enabled: true },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);

    const mockWhere = mock(() => ({
      orderBy: mock(() => Promise.resolve(mockSkills)),
    }));
    const mockFrom = mock(() => ({ where: mockWhere }));
    mockSkillsSelect.mockReturnValue({ from: mockFrom });

    const request = createMockRequest({
      searchParams: { enabled: 'true' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skills).toHaveLength(1);
  });

  it('returns 404 when workspace access denied for session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const request = createMockRequest();
    const params = Promise.resolve({ id: 'ws-1' });
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
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });
});

describe('POST /api/workspaces/[id]/skills', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockSkillsInsert.mockReset();
    mockSkillsUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test Skill', content: '# Test' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 when worker-level token attempts to create skill', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(workerAccount);

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_worker' },
      body: { name: 'Test Skill', content: '# Test' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 401 when trigger-level token attempts to create skill', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(triggerAccount);

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_trigger' },
      body: { name: 'Test Skill', content: '# Test' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 when name is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);

    const request = createMockRequest({
      method: 'POST',
      body: { content: '# Test' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('name and content are required');
  });

  it('returns 400 when content is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test Skill' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('name and content are required');
  });

  it('returns 400 when slug format is invalid', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test Skill', content: '# Test', slug: 'Invalid_Slug!' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('slug must be lowercase alphanumeric');
  });

  it('creates skill with valid body (session auth)', async () => {
    const createdSkill = {
      id: 'skill-123',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      slug: 'test-skill',
      content: '# Test',
      contentHash: expect.any(String),
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockWorkspaceSkillsFindFirst.mockResolvedValue(null); // No existing skill

    const mockReturning = mock(() => [createdSkill]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockSkillsInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test Skill', content: '# Test' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.skill.id).toBe('skill-123');
    expect(data.skill.name).toBe('Test Skill');
  });

  it('creates skill with admin API key auth', async () => {
    const createdSkill = {
      id: 'skill-123',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      slug: 'test-skill',
      content: '# Test',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockWorkspaceSkillsFindFirst.mockResolvedValue(null);

    const mockReturning = mock(() => [createdSkill]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockSkillsInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_admin_xxx' },
      body: { name: 'Test Skill', content: '# Test' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.skill.id).toBe('skill-123');
  });

  it('creates skill via OAuth JWT (admin-level connector token)', async () => {
    const createdSkill = {
      id: 'skill-123',
      workspaceId: 'ws-1',
      name: 'Builder Role',
      slug: 'builder',
      content: '# Builder',
      enabled: true,
    };

    // OAuth JWT resolves to admin account in authenticateApiKey
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(adminAccount);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockWorkspaceSkillsFindFirst.mockResolvedValue(null);

    const mockReturning = mock(() => [createdSkill]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockSkillsInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fake.jwt' },
      body: { name: 'Builder Role', content: '# Builder', isRole: true },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.skill.name).toBe('Builder Role');
  });

  it('updates existing skill when slug matches', async () => {
    const existingSkill = {
      id: 'skill-123',
      workspaceId: 'ws-1',
      slug: 'test-skill',
      name: 'Old Name',
      enabled: true,
    };

    const updatedSkill = {
      ...existingSkill,
      name: 'Updated Name',
      content: '# Updated',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockReturning = mock(() => [updatedSkill]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockSkillsUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Updated Name', content: '# Updated', slug: 'test-skill' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.name).toBe('Updated Name');
  });

  it('generates slug from name when slug not provided', async () => {
    const createdSkill = {
      id: 'skill-123',
      workspaceId: 'ws-1',
      name: 'My Test Skill',
      slug: 'my-test-skill',
      content: '# Test',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockWorkspaceSkillsFindFirst.mockResolvedValue(null);

    const mockReturning = mock(() => [createdSkill]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockSkillsInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'My Test Skill', content: '# Test' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.skill.slug).toBe('my-test-skill');
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test Skill', content: '# Test' },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('creates skill with all optional fields', async () => {
    const createdSkill = {
      id: 'skill-123',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      slug: 'test-skill',
      description: 'Test description',
      content: '# Test',
      source: 'manual',
      metadata: { key: 'value' },
      enabled: false,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockWorkspaceSkillsFindFirst.mockResolvedValue(null);

    const mockReturning = mock(() => [createdSkill]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockSkillsInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: {
        name: 'Test Skill',
        description: 'Test description',
        content: '# Test',
        source: 'manual',
        metadata: { key: 'value' },
        enabled: false,
      },
    });
    const params = Promise.resolve({ id: 'ws-1' });
    const response = await POST(request, { params });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.skill.description).toBe('Test description');
    expect(data.skill.enabled).toBe(false);
  });
});
