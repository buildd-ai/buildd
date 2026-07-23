import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockReconcile = mock(() => Promise.resolve({ total: 0, stamped: 0, closed: 0, skipped: 0 }));

mock.module('@/lib/pr-reconcile', () => ({
  reconcileStalePrWorkers: mockReconcile,
}));

import { GET } from './route';

function makeRequest(token?: string) {
  return new NextRequest('http://localhost/api/cron/pr-reconcile', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('GET /api/cron/pr-reconcile', () => {
  const originalEnv = process.env.CRON_SECRET;

  beforeEach(() => {
    mockReconcile.mockReset();
    process.env.CRON_SECRET = 'test-secret';
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalEnv;
  });

  it('returns 401 when no authorization header', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 when wrong token', async () => {
    const res = await GET(makeRequest('wrong'));
    expect(res.status).toBe(401);
  });

  it('returns 500 when CRON_SECRET not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest('anything'));
    expect(res.status).toBe(500);
  });

  it('calls reconcileStalePrWorkers and returns ok with counts', async () => {
    mockReconcile.mockResolvedValue({ total: 10, stamped: 4, closed: 2, skipped: 4 });
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stamped).toBe(4);
    expect(body.closed).toBe(2);
    expect(body.total).toBe(10);
  });

  it('returns 500 when reconcile throws', async () => {
    mockReconcile.mockRejectedValue(new Error('DB unavailable'));
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('DB unavailable');
  });
});
