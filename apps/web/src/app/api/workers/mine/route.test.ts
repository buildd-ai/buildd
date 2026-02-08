import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: { accountId: 'accountId', status: 'status', createdAt: 'createdAt' },
}));

import { GET } from './route';

function createMockRequest(
  headers: Record<string, string> = {},
  searchParams: Record<string, string> = {}
): NextRequest {
  let url = 'http://localhost:3000/api/workers/mine';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) url += `?${params.toString()}`;
  return new NextRequest(url, {
    method: 'GET',
    headers: new Headers(headers),
  });
}

describe('GET /api/workers/mine', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindMany.mockReset();
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid API key');
  });

  it('returns workers for authenticated account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'running', createdAt: new Date() },
      { id: 'w2', taskId: 'task-2', status: 'completed', createdAt: new Date() },
    ]);

    const req = createMockRequest({ Authorization: 'Bearer bld_test' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toHaveLength(2);
  });

  it('filters by status query param', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'running', createdAt: new Date() },
    ]);

    const req = createMockRequest(
      { Authorization: 'Bearer bld_test' },
      { status: 'running,starting' }
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toHaveLength(1);
  });

  it('returns empty array when no workers', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindMany.mockResolvedValue([]);

    const req = createMockRequest({ Authorization: 'Bearer bld_test' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toEqual([]);
  });
});
