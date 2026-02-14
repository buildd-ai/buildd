import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockWorkspaceSkillsFindFirst = mock(() => null as any);
const mockSkillsUpdate = mock(() => null as any);
const mockSkillsDelete = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(false));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock api-auth
mock.module('@/lib/api-auth', () => ({
  hashApiKey: (key: string) => `hashed_${key}`,
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
      accounts: { findFirst: mockAccountsFindFirst },
      workspaceSkills: { findFirst: mockWorkspaceSkillsFindFirst },
    },
    update: mockSkillsUpdate,
    delete: mockSkillsDelete,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id' },
  workspaceSkills: {
    id: 'id',
    workspaceId: 'workspaceId',
  },
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

describe('GET /api/workspaces/[id]/skills/[skillId]', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
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
    mockAccountsFindFirst.mockResolvedValue(null);
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

  it('returns skill for valid request with API key auth', async () => {
    const mockSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      slug: 'test-skill',
      content: '# Test',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'hashed_bld_xxx' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(mockSkill);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.id).toBe('skill-1');
  });

  it('returns 404 when skill not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
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
    mockAccountsFindFirst.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const request = createMockRequest();
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await GET(request, { params });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 404 when workspace access denied for API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'hashed_bld_xxx' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
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
    mockAccountsFindFirst.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockSkillsUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

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

  it('updates skill fields', async () => {
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
    mockAccountsFindFirst.mockResolvedValue(null);
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
      contentHash: expect.any(String), // Will be recomputed
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
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

  it('returns 404 when skill not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
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

  it('updates skill with API key auth', async () => {
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
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'hashed_bld_xxx' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockReturning = mock(() => [updatedSkill]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockSkillsUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { name: 'Updated Name' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await PATCH(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skill.name).toBe('Updated Name');
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
    mockAccountsFindFirst.mockResolvedValue(null);
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
    mockAccountsFindFirst.mockResolvedValue(null);
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
    mockAccountsFindFirst.mockReset();
    mockWorkspaceSkillsFindFirst.mockReset();
    mockSkillsDelete.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'DELETE',
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await DELETE(request, { params });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('deletes skill successfully', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
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

  it('returns 404 when skill not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
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

  it('deletes skill with API key auth', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'hashed_bld_xxx' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockWhere = mock(() => Promise.resolve());
    mockSkillsDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({
      method: 'DELETE',
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const params = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });
    const response = await DELETE(request, { params });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('returns 404 when workspace access denied', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
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
