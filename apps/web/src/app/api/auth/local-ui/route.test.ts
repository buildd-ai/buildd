// Ensure production mode — routes short-circuit in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// --- Mock functions ---

const mockAuth = mock(() => null as any);

const mockFindFirst = mock(() => null as any);
const mockInsertReturning = mock(() => [{ id: 'new-account-1' }] as any[]);
const mockInsertValues = mock(() => ({ returning: mockInsertReturning }));
const mockInsert = mock(() => ({ values: mockInsertValues }));
const mockUpdateReturning = mock(() => [{ id: 'existing-account-1' }] as any[]);
const mockUpdateWhere = mock(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
const mockUpdate = mock(() => ({ set: mockUpdateSet }));

const mockHashApiKey = mock((key: string) => `hashed_${key}`);
const mockExtractApiKeyPrefix = mock((key: string) => key.slice(0, 12));

// --- Register mocks before importing the route ---

mock.module('crypto', () => ({
  randomBytes: (size: number) => Buffer.alloc(size, 'a'),
}));

mock.module('@/auth', () => ({
  auth: mockAuth,
}));

mock.module('@/lib/api-auth', () => ({
  hashApiKey: mockHashApiKey,
  extractApiKeyPrefix: mockExtractApiKeyPrefix,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockFindFirst },
    },
    insert: mockInsert,
    update: mockUpdate,
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: {
    id: 'id',
    ownerId: 'ownerId',
    name: 'name',
  },
}));

import { GET } from './route';

// Deterministic key: bld_ + 64 'a' hex chars from Buffer.alloc(32, 'a')
const DETERMINISTIC_KEY = `bld_${'61'.repeat(32)}`;

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('GET /api/auth/local-ui', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuth.mockReset();
    mockFindFirst.mockReset();
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockInsertReturning.mockReset();
    mockInsertReturning.mockReturnValue([{ id: 'new-account-1' }]);
    mockUpdate.mockClear();
    mockUpdateSet.mockClear();
    mockUpdateWhere.mockClear();
    mockUpdateReturning.mockReset();
    mockUpdateReturning.mockReturnValue([{ id: 'existing-account-1' }]);
    mockHashApiKey.mockClear();
    mockExtractApiKeyPrefix.mockClear();
  });

  it('returns 400 when callback param is missing', async () => {
    const req = new NextRequest('http://localhost:3000/api/auth/local-ui');
    const res = await GET(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('callback parameter required');
  });

  it('returns 400 when callback is not localhost', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/auth/local-ui?callback=https://evil.com/callback'
    );
    const res = await GET(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Callback must be localhost');
  });

  it('returns 400 when callback URL is invalid', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/auth/local-ui?callback=not-a-url'
    );
    const res = await GET(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Invalid callback URL');
  });

  it('redirects to login when not authenticated', async () => {
    mockAuth.mockResolvedValue(null);

    const req = new NextRequest(
      'http://localhost:3000/api/auth/local-ui?callback=http://localhost:9876/auth/callback'
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/app/auth/signin');
    expect(location).toContain('callbackUrl=');
    expect(location).toContain(encodeURIComponent('/api/auth/local-ui'));
  });

  it('creates new account and redirects with token when no existing account', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockFindFirst.mockResolvedValue(null);

    const req = new NextRequest(
      'http://localhost:3000/api/auth/local-ui?callback=http://localhost:9876/auth/callback'
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('http://localhost:9876/auth/callback');
    expect(location).toContain(`token=${DETERMINISTIC_KEY}`);

    // Verify insert was called (not update)
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();

    // Verify hash was called with the deterministic key
    expect(mockHashApiKey).toHaveBeenCalledWith(DETERMINISTIC_KEY);
    expect(mockExtractApiKeyPrefix).toHaveBeenCalledWith(DETERMINISTIC_KEY);
  });

  it('rotates key on existing account and redirects with token', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockFindFirst.mockResolvedValue({ id: 'existing-account-1', name: 'Local UI' });

    const req = new NextRequest(
      'http://localhost:3000/api/auth/local-ui?callback=http://localhost:9876/auth/callback'
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('http://localhost:9876/auth/callback');
    expect(location).toContain(`token=${DETERMINISTIC_KEY}`);

    // Verify update was called (not insert)
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockInsert).not.toHaveBeenCalled();

    // Verify hash was called with the deterministic key
    expect(mockHashApiKey).toHaveBeenCalledWith(DETERMINISTIC_KEY);
    expect(mockExtractApiKeyPrefix).toHaveBeenCalledWith(DETERMINISTIC_KEY);
  });

  it('redirects to callback with error param on server error', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockFindFirst.mockRejectedValue(new Error('DB connection failed'));

    const req = new NextRequest(
      'http://localhost:3000/api/auth/local-ui?callback=http://localhost:9876/auth/callback'
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('http://localhost:9876/auth/callback');
    expect(location).toContain('error=Server+error');
  });
});
