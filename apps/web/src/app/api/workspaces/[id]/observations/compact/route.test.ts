// Ensure production mode — routes check NODE_ENV for dev bypass
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAccountsFindFirst = mock(() => null as any);

let mockSelectResults: any[] = [];
const mockSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => ({
      orderBy: mock(() => ({
        limit: mock(() => Promise.resolve(mockSelectResults)),
      })),
    })),
  })),
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

// Helper to create mock NextRequest
function createMockRequest(options: {
  headers?: Record<string, string>;
} = {}): NextRequest {
  const { headers = {} } = options;

  const url = 'http://localhost:3000/api/workspaces/ws-1/observations/compact';

  return new NextRequest(url, {
    method: 'GET',
    headers: new Headers(headers),
  });
}

describe('GET /api/workspaces/[id]/observations/compact', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAccountsFindFirst.mockReset();
    mockSelect.mockClear();
    mockSelectResults = [];
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when no auth and not dev mode', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns empty markdown for no observations', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });
    mockSelectResults = [];

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.markdown).toBe('');
    expect(data.count).toBe(0);
  });

  it('returns formatted markdown with observations', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });
    mockSelectResults = [
      {
        id: 'obs-1',
        type: 'gotcha',
        title: 'Watch Out',
        content: 'This is a gotcha about testing.',
        files: ['src/index.ts', 'src/utils.ts'],
        concepts: ['testing'],
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'obs-2',
        type: 'pattern',
        title: 'Common Pattern',
        content: 'Use this pattern for consistency.',
        files: [],
        concepts: ['architecture'],
        createdAt: '2024-01-02T00:00:00Z',
      },
    ];

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.count).toBe(2);
    expect(data.markdown).toContain('Workspace Memory (2 observations)');
    expect(data.markdown).toContain('Gotchas');
    expect(data.markdown).toContain('Watch Out');
    expect(data.markdown).toContain('src/index.ts');
    expect(data.markdown).toContain('Patterns');
    expect(data.markdown).toContain('Common Pattern');
  });

  it('API key auth works', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });
    mockSelectResults = [];

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('markdown');
    expect(data).toHaveProperty('count');
  });
});
