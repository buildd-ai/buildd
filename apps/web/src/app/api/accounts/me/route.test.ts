// Ensure production mode — routes short-circuit in development
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

import { GET } from './route';

afterAll(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('GET /api/accounts/me', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticateApiKey.mockReset();
  });

  it('returns 401 when no API key provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts/me');
    const res = await GET(req);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid API key');
  });

  it('returns 401 when invalid API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts/me', {
      headers: new Headers({ Authorization: 'Bearer bld_invalid_key' }),
    });
    const res = await GET(req);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid API key');
  });

  it('returns account info for valid API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      name: 'My Runner',
      type: 'user',
      level: 'worker',
      authType: 'api',
      maxConcurrentWorkers: 3,
    });

    const req = new NextRequest('http://localhost:3000/api/accounts/me', {
      headers: new Headers({ Authorization: 'Bearer bld_test' }),
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('account-1');
    expect(data.name).toBe('My Runner');
    expect(data.type).toBe('user');
    expect(data.level).toBe('worker');
    expect(data.authType).toBe('api');
    expect(data.maxConcurrentWorkers).toBe(3);
  });

  it('only returns safe fields (not full account object)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      name: 'My Runner',
      type: 'user',
      level: 'worker',
      authType: 'api',
      maxConcurrentWorkers: 3,
      apiKey: 'should-not-be-returned',
      totalCost: '100.00',
      email: 'secret@example.com',
      createdAt: new Date(),
    });

    const req = new NextRequest('http://localhost:3000/api/accounts/me', {
      headers: new Headers({ Authorization: 'Bearer bld_test' }),
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Only safe fields should be present
    const keys = Object.keys(data);
    expect(keys).toEqual(['id', 'name', 'type', 'level', 'authType', 'maxConcurrentWorkers']);
    // Sensitive fields must not leak
    expect(data.apiKey).toBeUndefined();
    expect(data.totalCost).toBeUndefined();
    expect(data.email).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
  });
});
