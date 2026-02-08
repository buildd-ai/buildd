import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindMany = mock(() => [] as any[]);
const mockAccountsInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'account-new', name: 'New Account', apiKey: 'hashed' }]),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findMany: mockAccountsFindMany },
    },
    insert: () => mockAccountsInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { ownerId: 'ownerId', createdAt: 'createdAt' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, POST } from './route';

describe('GET /api/accounts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindMany.mockReset();
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts');
    const res = await GET();

    expect(res.status).toBe(401);
  });

  it('returns accounts for authenticated user', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindMany.mockResolvedValue([
      { id: 'acc-1', name: 'My Runner', type: 'user' },
      { id: 'acc-2', name: 'Service', type: 'service' },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accounts).toHaveLength(2);
  });
});

describe('POST /api/accounts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsInsert.mockReset();
    process.env.NODE_ENV = 'production';

    mockAccountsInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'account-new', name: 'New Account', apiKey: 'hashed' }]),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Test', type: 'user' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 400 when name or type missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Test' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Name and type are required');
  });

  it('creates account and returns plaintext key', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'My Runner', type: 'user' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Should return plaintext key (starts with bld_)
    expect(data.apiKey).toBeDefined();
  });
});
