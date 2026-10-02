// Asserts on the cron_runs row against a mocked db, so opt in to recording.
process.env.BUILDD_CRON_RUN_RECORD_IN_TESTS = '1';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The executor is covered in apps/web/src/lib/knowledge-full-ingest-fallback.test.ts;
// here the wiring: auth, one tick per call, and the cron_runs verdict.
const empty = { considered: 0, claimed: [], completed: [], failed: [], errors: [], filesIngested: 0, raceLost: 0 };
let tickResult: any = empty;
const mockTick = mock(async () => tickResult);
mock.module('@/lib/knowledge-full-ingest-fallback', () => ({
  runFullIngestFallbackTick: mockTick,
  defaultFallbackDeps: async () => ({}),
}));

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
const req = (token: string | null = SECRET) => new NextRequest('http://localhost:3000/api/cron/knowledge-ingest-fallback', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const outcome = () => recorded.find(r => r.changed !== undefined);

describe('GET /api/cron/knowledge-ingest-fallback', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    tickResult = empty;
    mockTick.mockClear();
    recorded.length = 0;
  });

  it('refuses without the cron secret and runs nothing', async () => {
    expect((await GET(req('wrong'))).status).toBe(401);
    expect(mockTick).not.toHaveBeenCalled();
  });

  it('runs one tick and reports completed jobs as changed, failed slices as errors', async () => {
    tickResult = {
      ...empty,
      considered: 2,
      claimed: ['a', 'b'],
      completed: ['a'],
      errors: [{ id: 'b', error: 'GitHub API error: 502' }],
      filesIngested: 40,
    };
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockTick).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ ok: true, completed: ['a'], filesIngested: 40 });
    expect(outcome()).toMatchObject({ processed: 2, changed: 1, errors: 1 });
    expect(recorded.find(r => r.job === 'knowledge-ingest-fallback')).toBeDefined();
  });

  it('nothing stalled is a cheap, successful no-op', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(outcome()).toMatchObject({ processed: 0, changed: 0, errors: 0 });
  });
});
