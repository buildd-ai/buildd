// Ensure production mode — routes check NODE_ENV for dev bypass
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    delete: mockDelete,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  and: (...a: any[]) => ({ a, type: 'and' }),
  or: (...a: any[]) => ({ a, type: 'or' }),
  desc: (f: any) => ({ f, type: 'desc' }),
  ilike: (f: any, v: any) => ({ f, v, type: 'ilike' }),
  sql: Object.assign(
    (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
    { raw: (s: string) => s }
  ),
  inArray: (f: any, v: any) => ({ f, v, type: 'inArray' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  observations: {
    id: 'id',
    workspaceId: 'workspaceId',
    type: 'type',
    title: 'title',
    content: 'content',
    files: 'files',
    concepts: 'concepts',
    createdAt: 'createdAt',
  },
  accounts: { apiKey: 'apiKey', id: 'id' },
  workspaces: { id: 'id', ownerId: 'ownerId' },
}));

// Import handler AFTER mocks
import { DELETE } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  headers?: Record<string, string>;
} = {}): NextRequest {
  const { headers = {} } = options;

  const url = 'http://localhost:3000/api/workspaces/ws-1/observations/obs-1';

  return new NextRequest(url, {
    method: 'DELETE',
    headers: new Headers(headers),
  });
}

describe('DELETE /api/workspaces/[id]/observations/[obsId]', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockDelete.mockClear();
    // Reset the delete chain mock
    mockDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await DELETE(request, {
      params: Promise.resolve({ id: 'ws-1', obsId: 'obs-1' }),
    });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when workspace not found (not owned)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await DELETE(request, {
      params: Promise.resolve({ id: 'ws-1', obsId: 'obs-1' }),
    });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Workspace not found');
  });

  it('deletes observation successfully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockWhere = mock(() => Promise.resolve());
    mockDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest();
    const response = await DELETE(request, {
      params: Promise.resolve({ id: 'ws-1', obsId: 'obs-1' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });
});
