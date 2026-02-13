// Ensure production mode — routes check NODE_ENV for dev bypass
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);

// Chainable select mock
let selectCallCount = 0;
const mockSelect = mock(() => {
  selectCallCount++;
  const currentCall = selectCallCount;

  const chain = {
    from: mock(() => ({
      where: mock((..._args: any[]) => {
        // First call is count query, second is results query
        if (currentCall % 2 === 1) {
          // Count query — returns array directly
          return Promise.resolve([{ count: 5 }]);
        }
        // Results query — needs orderBy chain
        return {
          orderBy: mock(() => ({
            limit: mock(() => ({
              offset: mock(() => Promise.resolve([
                {
                  id: 'obs-1',
                  title: 'Test Observation',
                  type: 'gotcha',
                  files: ['src/index.ts'],
                  concepts: ['testing'],
                  createdAt: '2024-01-01T00:00:00Z',
                },
              ])),
            })),
          })),
        };
      }),
    })),
  };
  return chain;
});

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
    },
    select: mockSelect,
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
import { GET } from './route';

const mockParams = Promise.resolve({ id: 'ws-1' });

// Helper to create mock NextRequest
function createMockRequest(options: {
  headers?: Record<string, string>;
  searchParams?: Record<string, string>;
} = {}): NextRequest {
  const { headers = {}, searchParams = {} } = options;

  let url = 'http://localhost:3000/api/workspaces/ws-1/observations/search';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) {
    url += `?${params.toString()}`;
  }

  return new NextRequest(url, {
    method: 'GET',
    headers: new Headers(headers),
  });
}

describe('GET /api/workspaces/[id]/observations/search', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockSelect.mockClear();
    selectCallCount = 0;
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await GET(request, { params: mockParams });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns results for API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });

    // Reset call count for fresh chain
    selectCallCount = 0;

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toBeDefined();
    expect(data.total).toBe(5);
    expect(data.results[0].id).toBe('obs-1');
    expect(data.results[0].title).toBe('Test Observation');
  });

  it('supports query parameter for text search', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });
    selectCallCount = 0;

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
      searchParams: { query: 'test search' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toBeDefined();
  });

  it('supports type filter', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });
    selectCallCount = 0;

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
      searchParams: { type: 'gotcha' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toBeDefined();
  });

  it('supports limit and offset', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });
    selectCallCount = 0;

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
      searchParams: { limit: '5', offset: '10' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.limit).toBe(5);
    expect(data.offset).toBe(10);
  });

  it('returns count in response', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });
    selectCallCount = 0;

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.total).toBe(5);
    expect(typeof data.total).toBe('number');
  });
});
