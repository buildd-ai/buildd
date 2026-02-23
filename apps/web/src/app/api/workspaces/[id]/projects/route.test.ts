import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesUpdate = mock(() => ({
  set: mock(() => ({ where: mock(() => Promise.resolve()) })),
}));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

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
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    update: mockWorkspacesUpdate,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey' },
  workspaces: { id: 'id', projects: 'projects' },
}));

// Import handlers AFTER mocks
import { GET, PUT, POST } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body } = options;

  const url = 'http://localhost:3000/api/workspaces/ws-1/projects';
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

// Helper to call route handler with params
async function callHandler(
  handler: Function,
  request: NextRequest,
  id: string = 'ws-1'
) {
  return handler(request, { params: Promise.resolve({ id }) });
}

// ---------------------------------------------------------------
// GET /api/workspaces/[id]/projects
// ---------------------------------------------------------------

describe('GET /api/workspaces/[id]/projects', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: grant access
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(GET, request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when workspace access denied (session)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(GET, request);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns 404 when workspace access denied (API key)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(GET, request);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('returns empty array for workspace with no projects', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', projects: null });

    const request = createMockRequest();
    const response = await callHandler(GET, request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.projects).toEqual([]);
  });

  it('returns projects array for workspace with projects', async () => {
    const projects = [
      { name: '@mono/web', path: 'apps/web' },
      { name: '@mono/core', path: 'packages/core' },
    ];
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', projects });

    const request = createMockRequest();
    const response = await callHandler(GET, request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.projects).toHaveLength(2);
    expect(data.projects[0].name).toBe('@mono/web');
  });

  it('works with API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', projects: [{ name: 'my-app' }] });

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(GET, request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.projects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------
// PUT /api/workspaces/[id]/projects
// ---------------------------------------------------------------

describe('PUT /api/workspaces/[id]/projects', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);

    // Default update chain
    mockWorkspacesUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PUT',
      body: { projects: [] },
    });
    const response = await callHandler(PUT, request);

    expect(response.status).toBe(401);
  });

  it('returns 400 when projects is not an array', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const request = createMockRequest({
      method: 'PUT',
      body: { projects: 'not-array' },
    });
    const response = await callHandler(PUT, request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('projects must be an array');
  });

  it('returns 400 when project missing name', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const request = createMockRequest({
      method: 'PUT',
      body: { projects: [{ path: 'apps/web' }] },
    });
    const response = await callHandler(PUT, request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('name');
  });

  it('returns 400 when project name is not a string', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const request = createMockRequest({
      method: 'PUT',
      body: { projects: [{ name: 123 }] },
    });
    const response = await callHandler(PUT, request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('name');
  });

  it('successfully replaces projects array', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const projects = [
      { name: '@mono/web', path: 'apps/web' },
      { name: '@mono/core', path: 'packages/core' },
    ];

    const request = createMockRequest({
      method: 'PUT',
      body: { projects },
    });
    const response = await callHandler(PUT, request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.projects).toHaveLength(2);
    expect(data.projects[0].name).toBe('@mono/web');
    expect(data.projects[1].name).toBe('@mono/core');
  });

  it('normalizes to allowed fields only (strips extra fields)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const request = createMockRequest({
      method: 'PUT',
      body: {
        projects: [{
          name: '@mono/web',
          path: 'apps/web',
          description: 'Web app',
          color: '#ff0000',
          extraField: 'should be stripped',
          anotherExtra: 42,
        }],
      },
    });
    const response = await callHandler(PUT, request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.projects[0].name).toBe('@mono/web');
    expect(data.projects[0].path).toBe('apps/web');
    expect(data.projects[0].description).toBe('Web app');
    expect(data.projects[0].color).toBe('#ff0000');
    expect(data.projects[0].extraField).toBeUndefined();
    expect(data.projects[0].anotherExtra).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// POST /api/workspaces/[id]/projects
// ---------------------------------------------------------------

describe('POST /api/workspaces/[id]/projects', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);

    mockWorkspacesUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { name: '@mono/web' },
    });
    const response = await callHandler(POST, request);

    expect(response.status).toBe(401);
  });

  it('returns 400 when name missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const request = createMockRequest({
      method: 'POST',
      body: { path: 'apps/web' },
    });
    const response = await callHandler(POST, request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('name is required');
  });

  it('returns 201 when creating new project', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', projects: [] });

    const request = createMockRequest({
      method: 'POST',
      body: { name: '@mono/web', path: 'apps/web' },
    });
    const response = await callHandler(POST, request);

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.project.name).toBe('@mono/web');
    expect(data.projects).toHaveLength(1);
  });

  it('returns 200 when updating existing project (upsert)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      projects: [{ name: '@mono/web', path: 'old/path' }],
    });

    const request = createMockRequest({
      method: 'POST',
      body: { name: '@mono/web', path: 'new/path', description: 'Updated' },
    });
    const response = await callHandler(POST, request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project.name).toBe('@mono/web');
    expect(data.project.path).toBe('new/path');
    expect(data.project.description).toBe('Updated');
    expect(data.projects).toHaveLength(1);
  });

  it('merges optional fields (path, description, color)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', projects: [] });

    const request = createMockRequest({
      method: 'POST',
      body: {
        name: '@mono/web',
        path: 'apps/web',
        description: 'The web app',
        color: '#0066ff',
      },
    });
    const response = await callHandler(POST, request);

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.project.path).toBe('apps/web');
    expect(data.project.description).toBe('The web app');
    expect(data.project.color).toBe('#0066ff');
  });

  it('returns both the upserted project and full array', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      projects: [{ name: '@mono/core', path: 'packages/core' }],
    });

    const request = createMockRequest({
      method: 'POST',
      body: { name: '@mono/web', path: 'apps/web' },
    });
    const response = await callHandler(POST, request);

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.project.name).toBe('@mono/web');
    expect(data.projects).toHaveLength(2);
    expect(data.projects.map((p: any) => p.name).sort()).toEqual(['@mono/core', '@mono/web']);
  });
});
