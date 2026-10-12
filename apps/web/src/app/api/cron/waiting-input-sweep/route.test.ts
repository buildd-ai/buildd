import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The sweep itself is unit-tested in lib/stale-workers.test.ts; this file is
// about the trigger: auth, and that the route fans the account-scoped sweep out
// across every account (the reason a declared cron exists at all — a runner's
// own cleanup tick can only cover accounts whose runner is alive).

let candidateWorkers: any[] = [];
let answerCandidateWorkers: any[] = [];
// The route reads twice: stuck waiting_input workers, then workers holding an
// answer nobody has read yet.
let findManyCall = 0;
const mockWorkersFindMany = mock((_args: any) => (findManyCall++ === 0 ? candidateWorkers : answerCandidateWorkers));

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
  or: (...c: any[]) => ({ c, type: 'or' }),
  isNotNull: (f: any) => ({ f, type: 'isNotNull' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  // withCronRun imports this; mock.module replaces the whole module, so a
  // partial stub deletes the export for every other importer in the process.
  cronRuns: { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
  workers: { accountId: 'accountId', status: 'status', updatedAt: 'updatedAt', runner: 'runner', pendingInstructions: 'pendingInstructions' },
}));

const mockCleanupStuckWaitingInput = mock((_accountId: string) =>
  Promise.resolve({ failedWorkers: 0, retriedTasks: 0 }),
);
const mockCleanupUnresumedAnswers = mock((_accountId: string) => Promise.resolve({ degraded: 0 }));
const mockCleanupUnreadInteractiveAnswers = mock((_accountId: string) => Promise.resolve({ degraded: 0 }));
mock.module('@/lib/stale-workers', () => ({
  cleanupStuckWaitingInput: mockCleanupStuckWaitingInput,
  cleanupUnresumedAnswers: mockCleanupUnresumedAnswers,
  cleanupUnreadInteractiveAnswers: mockCleanupUnreadInteractiveAnswers,
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
  answerCandidateWorkers = [];
  findManyCall = 0;
  mockWorkersFindMany.mockClear();
  mockCleanupUnresumedAnswers.mockClear();
  mockCleanupUnreadInteractiveAnswers.mockClear();
  mockCleanupUnreadInteractiveAnswers.mockResolvedValue({ degraded: 0 });
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

// An answer nobody read must not wait on a runner's own cleanup timer: with
// every runner of the account down, this cron is the only thing that moves it.
describe('waiting-input-sweep cron — unread answers', () => {
  it('runs both answer sweeps for every account holding an unread answer, once each', async () => {
    answerCandidateWorkers = [
      { accountId: 'account-1' },
      { accountId: 'account-1' },
      { accountId: 'account-2' },
      { accountId: null },
    ];
    mockCleanupUnreadInteractiveAnswers.mockResolvedValue({ degraded: 1 });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.answersDegraded).toBe(2);
    expect(mockCleanupUnreadInteractiveAnswers).toHaveBeenCalledTimes(2);
    expect(mockCleanupUnresumedAnswers).toHaveBeenCalledTimes(2);
    expect(mockCleanupUnresumedAnswers).toHaveBeenCalledWith('account-2');
    // The stuck-question sweep is keyed on its own candidates, not these.
    expect(mockCleanupStuckWaitingInput).not.toHaveBeenCalled();
  });

  it('keeps sweeping other accounts when one account\'s answer sweep throws', async () => {
    answerCandidateWorkers = [{ accountId: 'account-bad' }, { accountId: 'account-good' }];
    mockCleanupUnreadInteractiveAnswers.mockImplementation((accountId: string) =>
      accountId === 'account-bad' ? Promise.reject(new Error('boom')) : Promise.resolve({ degraded: 1 }),
    );

    const res = await POST(makeRequest());

    const data = await res.json();
    expect(data.errors).toBe(1);
    expect(data.answersDegraded).toBe(1);
  });
});
