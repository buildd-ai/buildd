process.env.BUILDD_CRON_RUN_RECORD_IN_TESTS = '1';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockTick = mock(async () => ({ namespaces: 1, processed: 16, done: 0, denied: 0, failed: 2 }));
mock.module('@/lib/knowledge-reembed', () => ({ runReembedTick: mockTick }));

const recorded: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({ values: (v: any) => { recorded.push(v); return { returning: async () => [{ id: 'cron-run-1' }] }; } }),
    update: () => ({ set: (v: any) => { recorded.push(v); return { where: async () => {} }; } }),
    delete: () => ({ where: () => Promise.resolve() }),
    query: { cronRuns: { findMany: async () => [] } },
  },
}));

const { GET } = await import('./route');

const SECRET = 'test-cron-secret';
const req = (token: string | null = SECRET) => new NextRequest('http://localhost:3000/api/cron/knowledge-reembed', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

describe('GET /api/cron/knowledge-reembed', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockTick.mockClear();
    recorded.length = 0;
  });

  it('refuses without the cron secret and runs nothing', async () => {
    expect((await GET(req('wrong'))).status).toBe(401);
    expect(mockTick).not.toHaveBeenCalled();
  });

  it('runs one tick; processed rows are changed, failed rows are errors', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockTick).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ ok: true, processed: 16, failed: 2 });
    expect(recorded.find(r => r.changed !== undefined)).toMatchObject({ changed: 16, errors: 2 });
  });
});
