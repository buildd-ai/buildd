import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => ({ teamId: 'team-1', role: 'owner' }) as any);
const mockVerifyAccountWorkspaceAccess = mock(() => true as any);
const mockObservationsSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => ({
      orderBy: mock(() => ({
        limit: mock(() => ({
          offset: mock(() => [] as any[]),
        })),
      })),
    })),
  })),
}));
const mockObservationsInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'obs-1', type: 'discovery', title: 'Test' }]),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  hashApiKey: (key: string) => `hashed_${key}`,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    select: () => mockObservationsSelect(),
    insert: () => mockObservationsInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  ilike: (field: any, value: any) => ({ field, value, type: 'ilike' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  observations: { workspaceId: 'workspaceId', type: 'type', title: 'title', content: 'content', createdAt: 'createdAt', id: 'id' },
  workspaces: { id: 'id' },
  accounts: { apiKey: 'apiKey' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, POST } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

function createGetRequest(
  searchParams: Record<string, string> = {},
  headers: Record<string, string> = {}
): NextRequest {
  let url = 'http://localhost:3000/api/workspaces/ws-1/observations';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) url += `?${params.toString()}`;
  return new NextRequest(url, { headers: new Headers(headers) });
}

function createPostRequest(body: any, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/workspaces/ws-1/observations', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body: JSON.stringify(body),
  });
}

describe('GET /api/workspaces/[id]/observations', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createGetRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns observations for authenticated user', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindFirst.mockResolvedValue(null);

    const req = createGetRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.observations).toBeDefined();
  });

  it('supports API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1' });

    const req = createGetRequest({}, { Authorization: 'Bearer bld_test' });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
  });
});

describe('POST /api/workspaces/[id]/observations', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockObservationsInsert.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    process.env.NODE_ENV = 'production';

    mockObservationsInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'obs-1', type: 'discovery', title: 'Test' }]),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createPostRequest({ type: 'discovery', title: 'Test', content: 'Content' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid type', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createPostRequest({ type: 'invalid', title: 'Test', content: 'Content' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid type');
  });

  it('returns 400 when title missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createPostRequest({ type: 'discovery', content: 'Content' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('title and content are required');
  });

  it('returns 400 when content missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = createPostRequest({ type: 'discovery', title: 'Test' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
  });

  it('returns 404 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const req = createPostRequest({ type: 'discovery', title: 'Test', content: 'Content' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('creates observation successfully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const req = createPostRequest({
      type: 'discovery',
      title: 'Found a pattern',
      content: 'This codebase uses X pattern',
      files: ['src/lib/api.ts'],
      concepts: ['api'],
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.observation).toBeDefined();
  });
});
