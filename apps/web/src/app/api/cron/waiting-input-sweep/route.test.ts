import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The sweep itself is unit-tested in lib/stale-workers.test.ts; this file is
// about the trigger: auth, and that the route fans the account-scoped sweep out
// across every account (the reason a declared cron exists at all — a runner's
// own cleanup tick can only cover accounts whose runner is alive).

let candidateWorkers: any[] = [];
const mockWorkersFindMany = mock((_args: any) => candidateWorkers);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  // Operators withCronRun imports. mock.module is process-global, so a
  // partial stub removes them for every other importer too.
  desc: (a: any) => ({ a, op: 'desc' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  and: (...c: any[]) => ({ c, type: 'and' }),
  lt: (f: any, v: any) => ({ f, v, type: 'lt' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  // withCronRun imports this; mock.module replaces the whole module, so a
  // partial stub deletes the export for every other importer in the process.
  cronRuns: { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
  workers: { accountId: 'accountId', status: 'status', updatedAt: 'updatedAt' },
}));

const mockCleanupStuckWaitingInput = mock((_accountId: string) =>
  Promise.resolve({ failedWorkers: 0, retriedTasks: 0 }),
);
mock.module('@/lib/stale-workers', () => ({
  cleanupStuckWaitingInput: mockCleanupStuckWaitingInput,
}));

const { POST } = await import('./route');

const CRON_SECRET = 'test-cron-secret';

function makeRequest(token: string | null = CRON_SECRET): NextRequest {
  return new NextRequest('http://localhost/api/cron/waiting-input-sweep', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET;
  candidateWorkers = [];
  mockWorkersFindMany.mockClear();
  mockCleanupStuckWaitingInput.mockClear();
  mockCleanupStuckWaitingInput.mockResolvedValue({ failedWorkers: 0, retriedTasks: 0 });
});

describe('waiting-input-sweep cron — auth', () => {
  it('rejects a request without the cron secret', async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(401);
    expect(mockCleanupStuckWaitingInput).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong cron secret', async () => {
    const res = await POST(makeRequest('nope'));
    expect(res.status).toBe(401);
    expect(mockCleanupStuckWaitingInput).not.toHaveBeenCalled();
  });

  it('fails closed when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });
});

describe('waiting-input-sweep cron — fan-out', () => {
  it('sweeps every account that has a stuck waiting_input worker, once each', async () => {
    candidateWorkers = [
      { accountId: 'account-1', updatedAt: hoursAgo(30) },
      { accountId: 'account-1', updatedAt: hoursAgo(5) },
      { accountId: 'account-2', updatedAt: hoursAgo(6) },
      { accountId: null, updatedAt: hoursAgo(9) },
    ];
    mockCleanupStuckWaitingInput.mockResolvedValue({ failedWorkers: 1, retriedTasks: 1 });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accountsSwept).toBe(2);
    expect(data.failedWorkers).toBe(2);
    expect(data.retriedTasks).toBe(2);
    expect(mockCleanupStuckWaitingInput).toHaveBeenCalledTimes(2);
    expect(mockCleanupStuckWaitingInput).toHaveBeenCalledWith('account-1');
    expect(mockCleanupStuckWaitingInput).toHaveBeenCalledWith('account-2');
  });

  it('does nothing when no worker is past the finest threshold', async () => {
    candidateWorkers = [];

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accountsSwept).toBe(0);
    expect(mockCleanupStuckWaitingInput).not.toHaveBeenCalled();
  });

  it('keeps sweeping other accounts when one account throws', async () => {
    candidateWorkers = [
      { accountId: 'account-bad', updatedAt: hoursAgo(30) },
      { accountId: 'account-good', updatedAt: hoursAgo(30) },
    ];
    mockCleanupStuckWaitingInput.mockImplementation((accountId: string) =>
      accountId === 'account-bad'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ failedWorkers: 1, retriedTasks: 1 }),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.errors).toBe(1);
    expect(data.failedWorkers).toBe(1);
    expect(mockCleanupStuckWaitingInput).toHaveBeenCalledTimes(2);
  });
});
