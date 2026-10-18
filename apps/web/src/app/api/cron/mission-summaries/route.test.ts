import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The reconcile is covered in lib/mission-summary-store.test.ts; here the
// wiring: auth, the pass size, and what the route reports.
const counts = { checked: 3, missing: 1, otherVersion: 0, unchanged: 1, repaired: 1, missedWrites: 1, written: 3 };
const mockReconcile = mock(async (_opts?: { limit?: number }) => counts);
mock.module('@/lib/mission-summary-store', () => ({ reconcileMissionSummaries: mockReconcile }));

const { GET } = await import('./route');

const SECRET = 'test-cron-secret';
const req = (query = '', token: string | null = SECRET) => new NextRequest(`http://localhost:3000/api/cron/mission-summaries${query}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

describe('GET /api/cron/mission-summaries', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockReconcile.mockClear();
  });

  it('401 without the cron secret, and reconciles nothing', async () => {
    expect((await GET(req('', 'wrong'))).status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('one bounded pass at the default size, answering its counts', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith({});
    expect(await res.json()).toEqual({ ok: true, ...counts });
  });

  it('?limit sizes the pass (the store clamps it); a junk limit is the default', async () => {
    await GET(req('?limit=150'));
    expect(mockReconcile).toHaveBeenLastCalledWith({ limit: 150 });
    await GET(req('?limit=abc'));
    expect(mockReconcile).toHaveBeenLastCalledWith({});
  });
});
