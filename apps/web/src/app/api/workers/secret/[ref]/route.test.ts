import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockRedeemRef = mock(() => null as any);

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
}));

mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({
    redeemRef: mockRedeemRef,
  }),
}));

import { GET } from './route';

function createMockRequest(apiKey?: string, workerId?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const url = new URL('http://localhost:3000/api/workers/secret/ref-123');
  if (workerId) url.searchParams.set('workerId', workerId);
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: new Headers(headers),
  });
}

const mockParams = Promise.resolve({ ref: 'ref-123' });

describe('GET /api/workers/secret/[ref]', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockRedeemRef.mockReset();
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest(undefined, 'worker-1');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid API key');
  });

  it('returns 400 when workerId is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });

    const req = createMockRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('workerId is required');
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest('bld_test', 'worker-1');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 404 when worker belongs to different account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-2',
    });

    const req = createMockRequest('bld_test', 'worker-1');
    const res = await GET(req, { params: mockParams });

    // Route returns 404 for ownership mismatch (not 403) to avoid leaking info
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 410 when secret ref is expired or already redeemed', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
    });
    mockRedeemRef.mockResolvedValue(null);

    const req = createMockRequest('bld_test', 'worker-1');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(410);
    const data = await res.json();
    expect(data.error).toContain('expired');
  });

  it('returns secret value on successful redemption', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
    });
    mockRedeemRef.mockResolvedValue('secret-oauth-token');

    const req = createMockRequest('bld_test', 'worker-1');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.value).toBe('secret-oauth-token');
  });

  it('returns 500 when secrets provider throws', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
    });
    mockRedeemRef.mockRejectedValue(new Error('DB connection failed'));

    const req = createMockRequest('bld_test', 'worker-1');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Failed to redeem secret');
  });
});
