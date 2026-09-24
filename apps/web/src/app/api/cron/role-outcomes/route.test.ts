import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The DB half of the feed is stubbed at the scan boundary; the aggregation
// (lib/role-outcomes.ts) and withCronRun both run for real, so this test sees
// exactly the row the responder will read out of cron_runs.
let scanResult: any = { workers: [], heartbeats: [], truncated: false };
const mockScan = mock(async (_now: Date) => scanResult);
mock.module('@/lib/role-outcomes-scan', () => ({ scanRoleOutcomes: mockScan }));

const recorded: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({
      values: (v: any) => {
        recorded.push(v);
        return { returning: async () => [{ id: 'cron-run-1' }] };
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: () => Promise.resolve() }),
    query: { cronRuns: { findMany: async () => [] } },
  },
}));
mock.module('@/lib/pushover', () => ({ notify: mock(() => undefined) }));

const { GET } = await import('./route');
const { ROLE_OUTCOMES_JOB } = await import('@buildd/core/role-outcomes-feed');
const { getCronJobPolarity } = await import('@buildd/core/signal-registry');

const SECRET = 'test-cron-secret';
function req(token: string | null = SECRET) {
  return new NextRequest('http://localhost:3000/api/cron/role-outcomes', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('GET /api/cron/role-outcomes', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    recorded.length = 0;
    mockScan.mockClear();
    scanResult = { workers: [], heartbeats: [], truncated: false };
  });

  it('refuses without the cron secret and reads nothing', async () => {
    const res = await GET(req('wrong'));
    expect(res.status).toBe(401);
    expect(mockScan).not.toHaveBeenCalled();
  });

  it('records the per-role aggregate into cron_runs under the feed job', async () => {
    const now = Date.now();
    scanResult = {
      workers: [
        { status: 'failed', exitCause: 'code_failure', error: 'boom', roleSlug: 'builder', createdAt: new Date(now - 20 * 60_000), completedAt: new Date(now - 10 * 60_000) },
        { status: 'completed', exitCause: null, error: null, roleSlug: 'builder', createdAt: new Date(now - 5 * 3_600_000), completedAt: new Date(now - 5 * 3_600_000) },
      ],
      heartbeats: [{ runnerVersion: '1.1.0', runnerCommit: 'abc', lastHeartbeatAt: new Date(now - 60_000) }],
      truncated: false,
    };
    const res = await GET(req());
    expect(res.status).toBe(200);

    const row = recorded.find(r => r.job === ROLE_OUTCOMES_JOB);
    expect(row).toBeDefined();
    expect(row.ok).toBe(true);
    expect(row.processed).toBe(2);
    expect(row.changed).toBe(1);
    expect(row.errors).toBe(0);
    expect(row.result.scope).toBe('role-outcomes');
    expect(row.result.roles[0]).toMatchObject({
      role: 'builder',
      recent: { succeeded: 0, failed: 1 },
      baseline: { succeeded: 1, failed: 0 },
    });
    expect(row.result.runnerVersions).toEqual([{ version: '1.1.0', commit: 'abc', runners: 1 }]);
  });

  it('a quiet hour records zero buckets and is still a healthy run', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const row = recorded.find(r => r.job === ROLE_OUTCOMES_JOB);
    expect(row.changed).toBe(0);
    expect(row.result.roles).toEqual([]);
  });

  it('is declared work-polarity, so a busy hour never reads as findings', () => {
    expect(getCronJobPolarity(ROLE_OUTCOMES_JOB)).toBe('work');
  });
});
