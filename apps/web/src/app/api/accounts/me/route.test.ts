import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

import { GET } from './route';

describe('GET /api/accounts/me', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts/me');
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
    expect(data.maxConcurrentWorkers).toBe(3);
  });

  it('does not leak sensitive fields', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      name: 'My Runner',
      type: 'user',
      level: 'worker',
      authType: 'api',
      maxConcurrentWorkers: 3,
      apiKey: 'should-not-be-returned',
      totalCost: '100.00',
    });

    const req = new NextRequest('http://localhost:3000/api/accounts/me', {
      headers: new Headers({ Authorization: 'Bearer bld_test' }),
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Only safe fields should be returned
    expect(data.apiKey).toBeUndefined();
    expect(data.totalCost).toBeUndefined();
  });
});
