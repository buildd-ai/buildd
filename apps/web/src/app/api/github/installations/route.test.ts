// Ensure production mode — route short-circuits in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuth = mock(() => null as any);
const mockIsGitHubAppConfigured = mock(() => false as boolean);
const mockFindMany = mock(() => [] as any[]);

// Mock @/auth
mock.module('@/auth', () => ({
  auth: mockAuth,
}));

// Mock @/lib/github
mock.module('@/lib/github', () => ({
  isGitHubAppConfigured: mockIsGitHubAppConfigured,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: {
        findMany: mockFindMany,
      },
    },
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  desc: (field: any) => ({ field, type: 'desc' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: { createdAt: 'createdAt', id: 'id' },
}));

// Import handler AFTER mocks
import { GET } from './route';

function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/github/installations');
}

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('GET /api/github/installations', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockIsGitHubAppConfigured.mockReset();
    mockFindMany.mockReset();
    // Keep production mode for each test
    process.env.NODE_ENV = 'production';
  });

  it('returns empty installations and configured:false in development mode', async () => {
    process.env.NODE_ENV = 'development';

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.installations).toEqual([]);
    expect(data.configured).toBe(false);
  });

  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET(createRequest());
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns configured:false when GitHub App not configured', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(false);

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.installations).toEqual([]);
    expect(data.configured).toBe(false);
  });

  it('returns installations list successfully', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockFindMany.mockResolvedValue([
      {
        id: 'inst-1',
        installationId: 12345,
        accountType: 'Organization',
        accountLogin: 'my-org',
        accountAvatarUrl: 'https://avatars.githubusercontent.com/u/1',
        repositorySelection: 'all',
        suspendedAt: null,
        createdAt: '2025-01-01T00:00:00Z',
      },
    ]);

    const response = await GET(createRequest());
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.configured).toBe(true);
    expect(data.installations).toHaveLength(1);
    expect(data.installations[0].id).toBe('inst-1');
    expect(data.installations[0].installationId).toBe(12345);
    expect(data.installations[0].accountLogin).toBe('my-org');
  });

  it('returns 500 on DB error', async () => {
    mockAuth.mockResolvedValue({ user: { email: 'user@test.com' } });
    mockIsGitHubAppConfigured.mockReturnValue(true);
    mockFindMany.mockRejectedValue(new Error('DB connection failed'));

    const response = await GET(createRequest());
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe('Failed to get installations');
  });
});
