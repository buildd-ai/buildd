// Ensure production mode — routes check NODE_ENV for dev bypass
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);

const mockSelectResults: any[] = [];
const mockSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => Promise.resolve(mockSelectResults)),
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
  searchParams?: Record<string, string>;
} = {}): NextRequest {
  const { headers = {}, searchParams = {} } = options;

  let url = 'http://localhost:3000/api/workspaces/ws-1/observations/batch';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) {
    url += `?${params.toString()}`;
  }

  return new NextRequest(url, {
    method: 'GET',
    headers: new Headers(headers),
  });
}

describe('GET /api/workspaces/[id]/observations/batch', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockSelect.mockClear();
    mockSelectResults.length = 0;
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      searchParams: { ids: '550e8400-e29b-41d4-a716-446655440000' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 when ids param missing', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('ids parameter is required');
  });

  it('returns 400 when more than 20 IDs', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });

    // Generate 21 valid UUIDs
    const ids = Array.from({ length: 21 }, (_, i) =>
      `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, '0')}`
    );

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
      searchParams: { ids: ids.join(',') },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Maximum 20 IDs per request');
  });

  it('returns 400 for invalid UUID format', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
      searchParams: { ids: 'not-a-uuid,also-bad' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Invalid UUID format');
    expect(data.error).toContain('not-a-uuid');
  });

  it('returns empty array when ids resolves to empty after filtering', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });

    // Commas only — idsParam is truthy but all entries are empty after filter(Boolean)
    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
      searchParams: { ids: ',,,' },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.observations).toEqual([]);
  });

  it('returns observations for valid IDs', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'hashed_bld_xxx' });

    const mockObs = [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        workspaceId: 'ws-1',
        type: 'gotcha',
        title: 'Test Gotcha',
        content: 'Watch out for this',
        files: ['src/index.ts'],
        concepts: ['testing'],
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: '550e8400-e29b-41d4-a716-446655440001',
        workspaceId: 'ws-1',
        type: 'pattern',
        title: 'Test Pattern',
        content: 'Use this pattern',
        files: [],
        concepts: ['architecture'],
        createdAt: '2024-01-02T00:00:00Z',
      },
    ];

    mockSelectResults.push(...mockObs);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
      searchParams: {
        ids: '550e8400-e29b-41d4-a716-446655440000,550e8400-e29b-41d4-a716-446655440001',
      },
    });
    const response = await GET(request, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.observations).toHaveLength(2);
    expect(data.observations[0].id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(data.observations[1].title).toBe('Test Pattern');
  });
});
