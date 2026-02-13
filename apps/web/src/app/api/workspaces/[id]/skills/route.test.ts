import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockSkillsFindMany = mock(() => [] as any[]);
const mockSkillsFindFirst = mock(() => null as any);
const mockSkillsInsert = mock(() => ({
  values: mock(() => ({
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
      skills: { findMany: mockSkillsFindMany, findFirst: mockSkillsFindFirst },
    },
    insert: () => mockSkillsInsert(),
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
import { GET, POST } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

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

describe('GET /api/workspaces/[id]/skills', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockSkillsFindMany.mockReset();
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

  it('returns skills for session auth', async () => {
    const mockSkills = [
      { id: 'skill-1', name: 'Build', slug: 'build', workspaceId: 'ws-1' },
      { id: 'skill-2', name: 'Test', slug: 'test', workspaceId: 'ws-1' },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockSkillsFindMany.mockResolvedValue(mockSkills);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skills).toHaveLength(2);
    expect(data.skills[0].id).toBe('skill-1');
    expect(data.skills[1].id).toBe('skill-2');
  });

  it('returns skills for API key auth', async () => {
    const mockSkills = [
      { id: 'skill-1', name: 'Build', slug: 'build', workspaceId: 'ws-1' },
    ];

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });
    mockSkillsFindMany.mockResolvedValue(mockSkills);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0].name).toBe('Build');
  });

  it('supports enabled filter', async () => {
    const mockSkills = [
      { id: 'skill-1', name: 'Build', slug: 'build', enabled: true, workspaceId: 'ws-1' },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockSkillsFindMany.mockResolvedValue(mockSkills);

    const req = createMockRequest({
      searchParams: { enabled: 'true' },
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skills).toHaveLength(1);
  });
});

describe('POST /api/workspaces/[id]/skills', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockSkillsFindFirst.mockReset();
    mockSkillsInsert.mockReset();
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'POST',
      body: { name: 'Test Skill', content: 'some content' },
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'POST',
      body: { name: 'Test Skill', content: 'some content' },
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 400 when name is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = createMockRequest({
      method: 'POST',
      body: { content: 'some content' },
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('name and content are required');
  });

  it('returns 400 when content is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = createMockRequest({
      method: 'POST',
      body: { name: 'Test Skill' },
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('name and content are required');
  });

  it('returns 409 when duplicate slug exists', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockSkillsFindFirst.mockResolvedValue({ id: 'existing-skill' });

    const req = createMockRequest({
      method: 'POST',
      body: { name: 'Test Skill', content: 'some content', slug: 'test-skill' },
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('already exists');
  });

  it('creates skill successfully', async () => {
    const createdSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'Test Skill',
      slug: 'test-skill',
      content: 'some content',
      description: null,
      source: 'manual',
      metadata: {},
      enabled: true,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockSkillsFindFirst.mockResolvedValue(null); // No duplicate

    const mockReturning = mock(() => [createdSkill]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockSkillsInsert.mockReturnValue({ values: mockValues });

    const req = createMockRequest({
      method: 'POST',
      body: { name: 'Test Skill', content: 'some content' },
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.skill.id).toBe('skill-1');
    expect(data.skill.name).toBe('Test Skill');
    expect(data.skill.slug).toBe('test-skill');
  });

  it('creates skill with source=local_scan and enabled=false', async () => {
    const createdSkill = {
      id: 'skill-scan-1',
      workspaceId: 'ws-1',
      name: 'Scanned Skill',
      slug: 'scanned-skill',
      content: '# Scanned\n\nFrom local disk.',
      description: 'Discovered locally',
      source: 'local_scan',
      metadata: { referenceFiles: { 'REFERENCE.md': '# Ref' } },
      enabled: false,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockSkillsFindFirst.mockResolvedValue(null); // No duplicate

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdSkill]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockSkillsInsert.mockReturnValue({ values: mockValues });

    const req = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        name: 'Scanned Skill',
        slug: 'scanned-skill',
        content: '# Scanned\n\nFrom local disk.',
        description: 'Discovered locally',
        source: 'local_scan',
        enabled: false,
        metadata: { referenceFiles: { 'REFERENCE.md': '# Ref' } },
      },
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.skill.source).toBe('local_scan');
    expect(data.skill.enabled).toBe(false);

    // Verify the values passed to insert
    expect(capturedValues.source).toBe('local_scan');
    expect(capturedValues.enabled).toBe(false);
    expect(capturedValues.metadata).toEqual({ referenceFiles: { 'REFERENCE.md': '# Ref' } });
  });

  it('auto-generates slug from name', async () => {
    const createdSkill = {
      id: 'skill-1',
      workspaceId: 'ws-1',
      name: 'My Cool Skill!',
      slug: 'my-cool-skill',
      content: 'some content',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockSkillsFindFirst.mockResolvedValue(null); // No duplicate

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdSkill]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockSkillsInsert.mockReturnValue({ values: mockValues });

    const req = createMockRequest({
      method: 'POST',
      body: { name: 'My Cool Skill!', content: 'some content' },
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(201);
    // The slug should be auto-generated from the name
    expect(capturedValues.slug).toBe('my-cool-skill');
  });
});
