import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

// The two sweeps are unit-tested beside their files (stale-workers.test.ts,
// path-claims.test.ts). This file is about the trigger: auth, that both sweeps
// run on every tick, and that the run row carries what they did.

let cronRunRows: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({
      values: (v: any) => {
        cronRunRows.push(v);
        return { returning: async () => [{ id: 'run-1' }] };
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
    query: { cronRuns: { findMany: async () => [] } },
  },
}));
mock.module('drizzle-orm', () => ({
  // Operators withCronRun imports. mock.module is process-global, so a
  // partial stub removes them for every other importer too.
  and: (...c: any[]) => ({ c }),
  desc: (a: any) => ({ a }),
  eq: (a: any, b: any) => ({ a, b }),
  gt: (a: any, b: any) => ({ a, b }),
  lt: (a: any, b: any) => ({ a, b }),
}));
mock.module('@buildd/core/db/schema', () => ({
  cronRuns: { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
}));

const calls: string[] = [];
const mockStaleWorkers = mock(async (_now: Date) => { calls.push('stale-workers'); return 0; });
const mockPathClaims = mock(async () => { calls.push('path-claims'); return 0; });
mock.module('./stale-workers', () => ({ runStaleWorkerCleanup: mockStaleWorkers }));
mock.module('./path-claims', () => ({ sweepAbandonedPathClaims: mockPathClaims }));

const { GET } = await import('./route');

const CRON_SECRET = 'test-cron-secret';
function makeRequest(token: string | null = CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost/api/cron/maintenance', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.BUILDD_CRON_RUN_RECORD_IN_TESTS = '1';
  cronRunRows = [];
  calls.length = 0;
  mockStaleWorkers.mockClear();
  mockPathClaims.mockClear();
});

describe('maintenance cron — auth', () => {
  it('rejects a request without the cron secret and runs nothing', async () => {
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('rejects the wrong cron secret', async () => {
    expect((await GET(makeRequest('nope'))).status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('maintenance cron — the core sweeps', () => {
  it('runs stale-worker cleanup then abandoned path-claim release, the order the schedules tick used', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(calls).toEqual(['stale-workers', 'path-claims']);
    expect(mockStaleWorkers.mock.calls[0]![0]).toBeInstanceOf(Date);
  });

  it('returns and records what each sweep did; changed counts real repairs', async () => {
    mockStaleWorkers.mockResolvedValueOnce(2);
    mockPathClaims.mockResolvedValueOnce(3);
    const res = await GET(makeRequest());
    expect(await res.json()).toEqual({ heartbeatOrphans: 2, abandonedClaimsReleased: 3 });
    const row = cronRunRows.find(r => r.job === 'maintenance');
    expect(row).toMatchObject({ ok: true, changed: 5, errors: 0, result: { heartbeatOrphans: 2, abandonedClaimsReleased: 3 } });
  });
});

describe('the split from the schedules tick', () => {
  const schedulesSrc = readFileSync(join(import.meta.dir, '..', 'schedules', 'route.ts'), 'utf8');

  it('schedules no longer runs the core sweeps, so they run exactly once an hour', () => {
    expect(schedulesSrc).not.toContain('runStaleWorkerCleanup');
    expect(schedulesSrc).not.toContain('sweepAbandonedPathClaims');
  });
});
