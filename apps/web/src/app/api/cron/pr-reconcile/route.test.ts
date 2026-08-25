import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockReconcile = mock(() => Promise.resolve({ total: 0, stamped: 0, closed: 0, skipped: 0 }));
const mockDeadZone = mock(() => Promise.resolve({ total: 0, sparked: 0, exhausted: 0, skipped: 0 }));

mock.module('@/lib/pr-reconcile', () => ({
  reconcileStalePrWorkers: mockReconcile,
}));

mock.module('@/lib/dead-zone-sweep', () => ({
  sweepDeadZonePrs: mockDeadZone,
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
    mockDeadZone.mockReset();
    mockReconcile.mockResolvedValue({ total: 0, stamped: 0, closed: 0, skipped: 0 });
    mockDeadZone.mockResolvedValue({ total: 0, sparked: 0, exhausted: 0, skipped: 0 });
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

  it('runs both sweeps and returns nested counts on success', async () => {
    mockReconcile.mockResolvedValue({ total: 10, stamped: 4, closed: 2, skipped: 4 });
    mockDeadZone.mockResolvedValue({ total: 5, sparked: 2, exhausted: 1, skipped: 2 });

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(body.reconcile.total).toBe(10);
    expect(body.reconcile.stamped).toBe(4);
    expect(body.reconcile.closed).toBe(2);
    expect(body.reconcile.skipped).toBe(4);

    expect(body.deadZone.total).toBe(5);
    expect(body.deadZone.sparked).toBe(2);
    expect(body.deadZone.exhausted).toBe(1);
    expect(body.deadZone.skipped).toBe(2);

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockDeadZone).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when reconcileStalePrWorkers throws', async () => {
    mockReconcile.mockRejectedValue(new Error('DB unavailable'));
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('DB unavailable');
  });

  it('returns 500 when sweepDeadZonePrs throws', async () => {
    mockDeadZone.mockRejectedValue(new Error('GitHub timeout'));
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('GitHub timeout');
  });
});
