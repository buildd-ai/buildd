// Asserts on the cron_runs row against a mocked db, so opt in to recording.
process.env.BUILDD_CRON_RUN_RECORD_IN_TESTS = '1';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The indexer is covered in apps/web/src/lib/evidence-indexer.test.ts; here the
// wiring: auth, one sweep per tick, and the cron_runs verdict.
let sweepResult: any = { considered: 0, indexed: 0, skipped: 0, failed: 0, deferred: 0, chunks: 0 };
const mockSweep = mock(async () => {
  if (sweepResult instanceof Error) throw sweepResult;
  return sweepResult;
});
mock.module('@/lib/evidence-indexer', () => ({ runEvidenceIndexSweep: mockSweep }));

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
const req = (token: string | null = SECRET) => new NextRequest('http://localhost:3000/api/cron/evidence-index', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const outcome = () => recorded.find(r => r.changed !== undefined);

describe('GET /api/cron/evidence-index', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    sweepResult = { considered: 0, indexed: 0, skipped: 0, failed: 0, deferred: 0, chunks: 0 };
    mockSweep.mockClear();
    recorded.length = 0;
  });

  it('refuses without the cron secret and sweeps nothing', async () => {
    expect((await GET(req('wrong'))).status).toBe(401);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('runs one sweep and reports indexed rows as changed, failures as errors', async () => {
    sweepResult = { considered: 4, indexed: 2, skipped: 1, failed: 1, deferred: 0, chunks: 9 };
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ ok: true, indexed: 2, failed: 1, chunks: 9 });
    expect(outcome()).toMatchObject({ processed: 4, changed: 3, errors: 1 });
    expect(recorded.find(r => r.job === 'evidence-index')).toBeDefined();
  });

  it('an empty queue is a cheap, successful no-op', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(outcome()).toMatchObject({ processed: 0, changed: 0, errors: 0 });
  });

  it('a sweep that throws is recorded as a failed run', async () => {
    sweepResult = new Error('db unreachable');
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(recorded.some(r => r.ok === false)).toBe(true);
  });
});
