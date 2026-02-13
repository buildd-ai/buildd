import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockSkillsFindFirst = mock(() => null as any);
const mockSkillsUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => []),
    })),
  })),
}));
const mockSkillsDelete = mock(() => ({
  where: mock(() => ({
    returning: mock(() => []),
  })),
}));

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock api-auth
mock.module('@/lib/api-auth', () => ({
  hashApiKey: (key: string) => `hashed_${key}`,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      skills: { findFirst: mockSkillsFindFirst },
    },
    update: () => mockSkillsUpdate(),
    delete: () => mockSkillsDelete(),
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  skills: { id: 'id', workspaceId: 'workspaceId', slug: 'slug', enabled: 'enabled' },
  workspaces: { id: 'id', ownerId: 'ownerId' },
  accounts: { apiKey: 'apiKey' },
}));

const originalNodeEnv = process.env.NODE_ENV;

// Import handlers AFTER mocks
import { GET, PATCH, DELETE } from './route';

const mockParams = Promise.resolve({ id: 'ws-1', skillId: 'skill-1' });

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
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockSkillsFindFirst.mockReset();
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when skill not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockSkillsFindFirst.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Skill not found');
  });

  it('returns skill successfully', async () => {
    const mockSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Build',
      slug: 'build',
      content: 'Build instructions',
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockSkillsFindFirst.mockResolvedValue(mockSkill);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skill.id).toBe('skill-1');
    expect(data.skill.name).toBe('Build');
    expect(data.skill.content).toBe('Build instructions');
  });
});

describe('PATCH /api/workspaces/[id]/skills/[skillId]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockSkillsFindFirst.mockReset();
    mockSkillsUpdate.mockReset();
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated Skill' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated Skill' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 404 when skill not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockSkillsFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated Skill' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Skill not found');
  });

  it('returns 409 when changing slug to duplicate', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Build',
      slug: 'build',
      content: 'Build instructions',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    // First call returns the existing skill, second call returns a duplicate for slug check
    let findFirstCallCount = 0;
    mockSkillsFindFirst.mockImplementation(() => {
      findFirstCallCount++;
      if (findFirstCallCount === 1) return existingSkill; // existing skill lookup
      return { id: 'skill-other' }; // duplicate slug check
    });

    const req = createMockRequest({
      method: 'PATCH',
      body: { slug: 'deploy' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('already exists');
  });

  it('updates skill successfully', async () => {
    const existingSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Build',
      slug: 'build',
      content: 'Build instructions',
    };

    const updatedSkill = {
      ...existingSkill,
      name: 'Updated Build',
      content: 'Updated instructions',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockSkillsFindFirst.mockResolvedValue(existingSkill);

    const mockReturning = mock(() => [updatedSkill]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockSkillsUpdate.mockReturnValue({ set: mockSet });

    const req = createMockRequest({
      method: 'PATCH',
      body: { name: 'Updated Build', content: 'Updated instructions' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skill.name).toBe('Updated Build');
    expect(data.skill.content).toBe('Updated instructions');
  });
});

describe('DELETE /api/workspaces/[id]/skills/[skillId]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockSkillsDelete.mockReset();
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 404 when skill not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => []); // empty = not found
    const mockWhere = mock(() => ({ returning: mockReturning }));
    mockSkillsDelete.mockReturnValue({ where: mockWhere });

    const req = createMockRequest({ method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Skill not found');
  });

  it('deletes skill successfully', async () => {
    const deletedSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Build',
      slug: 'build',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => [deletedSkill]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    mockSkillsDelete.mockReturnValue({ where: mockWhere });

    const req = createMockRequest({ method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
