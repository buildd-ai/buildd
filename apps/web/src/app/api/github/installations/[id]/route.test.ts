// Ensure production mode — route short-circuits in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuth = mock(() => null as any);
const mockFindFirst = mock(() => null as any);
const mockDeleteWhere = mock(() => Promise.resolve());
const mockDelete = mock(() => ({
  where: mockDeleteWhere,
}));

// Mock @/auth
mock.module('@/auth', () => ({
  auth: mockAuth,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: {
        findFirst: mockFindFirst,
      },
    },
    delete: mockDelete,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: { id: 'id' },
}));

// Import handler AFTER mocks
import { DELETE } from './route';

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/github/installations/inst-1', {
    method: 'DELETE',
  });
}

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('DELETE /api/github/installations/[id]', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockFindFirst.mockReset();
    mockDeleteWhere.mockReset();
    mockDelete.mockReset();
    mockDelete.mockImplementation(() => ({
      where: mockDeleteWhere,
    }));
    mockDeleteWhere.mockResolvedValue(undefined);
    // Keep production mode for each test
    process.env.NODE_ENV = 'production';
  });

  it('returns ok in development mode', async () => {
    process.env.NODE_ENV = 'development';

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await DELETE(createRequest(), { params: mockParams });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.ok).toBe(true);
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await DELETE(createRequest(), { params: mockParams });
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when installation not found', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockFindFirst.mockResolvedValue(null);

    const mockParams = Promise.resolve({ id: 'inst-nonexistent' });
    const response = await DELETE(createRequest(), { params: mockParams });
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toBe('Installation not found');
  });

  it('deletes installation successfully', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockFindFirst.mockResolvedValue({
      id: 'inst-1',
      installationId: 12345,
      accountLogin: 'my-org',
    });

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await DELETE(createRequest(), { params: mockParams });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.ok).toBe(true);

    // Verify delete was called
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
  });

  it('returns 500 on DB error', async () => {
    const spy = mock(() => {});
    console.error = spy;

    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockFindFirst.mockRejectedValue(new Error('DB connection failed'));

    const mockParams = Promise.resolve({ id: 'inst-1' });
    const response = await DELETE(createRequest(), { params: mockParams });
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe('Failed to disconnect');
    expect(spy).toHaveBeenCalled();
  });
});
