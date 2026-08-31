process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(async () => null as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

let accessibleWorkspaceIds = new Set<string>(['ws-1']);
mock.module('@/lib/knowledge-ingest-access', () => ({
  getIngestAccessibleWorkspaceIds: mock(async () => accessibleWorkspaceIds),
}));

type Row = Record<string, any>;
let queuedJobs: Row[] = [];
let updateCalls: Array<{ set: Row }> = [];
// Result of each successive claim UPDATE, in call order. [] simulates losing
// the atomic race (WHERE status='queued' matched nothing). Kept free of any
// drizzle-condition introspection so cross-file drizzle-orm module mocks
// (Bun mock.module leaks between test files) can't break this suite.
let claimResults: Row[][] = [];
// Order of operations across the route, so the reclaim-before-scan invariant is
// assertable (a reclaim that ran after candidate selection would heal nothing
// until the next poll).
let callLog: string[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => {
              callLog.push('select-candidates');
              return Promise.resolve(queuedJobs);
            },
          }),
        }),
      }),
    }),
    update: () => ({
      set: (set: Row) => ({
        where: (_cond: any) => ({
          returning: () => {
            updateCalls.push({ set });
            callLog.push('claim-update');
            return Promise.resolve(claimResults.shift() ?? []);
          },
        }),
      }),
    }),
  },
}));

// Reclaim is stubbed so this suite tests the route's wiring, not the reclaim
// decision table (covered in apps/web/src/lib/knowledge-ingest-lease.test.ts).
let reclaimSummary = { scanned: 0, requeued: [] as string[], parked: [] as string[], escalated: [] as string[], stalled: [] as any[], raceLost: 0 };
const mockReclaim = mock(async () => {
  callLog.push('reclaim');
  return reclaimSummary;
});
mock.module('@/lib/knowledge-ingest-lease', () => ({
  reclaimStaleIngestJobs: mockReclaim,
  FULL_LEASE_MS: 60 * 60 * 1000,
}));

import { POST } from './route';

function createRequest(body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/knowledge/ingest-jobs/claim', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', authorization: 'Bearer bld_test' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const account = { id: 'account-1', level: 'admin', authType: 'api' };

describe('POST /api/knowledge/ingest-jobs/claim', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(account);
    accessibleWorkspaceIds = new Set(['ws-1']);
    queuedJobs = [];
    updateCalls = [];
    claimResults = [];
    callLog = [];
    reclaimSummary = { scanned: 0, requeued: [], parked: [], escalated: [], stalled: [], raceLost: 0 };
    mockReclaim.mockClear();
  });

  it('returns 401 without a valid API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await POST(createRequest({ repos: ['test-org/test-repo'] }));
    expect(res.status).toBe(401);
  });

  it('rejects trigger-level tokens', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...account, level: 'trigger' });
    const res = await POST(createRequest({ repos: ['test-org/test-repo'] }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when repos is missing or empty', async () => {
    expect((await POST(createRequest({}))).status).toBe(400);
    expect((await POST(createRequest({ repos: [] }))).status).toBe(400);
    expect((await POST(createRequest({ repos: 'not-an-array' }))).status).toBe(400);
  });

  it('claims the oldest queued full job matching an offered repo', async () => {
    queuedJobs = [
      { id: 'job-a', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'queued', scope: 'full', sha: 'sha-1', trigger: 'backfill' },
      { id: 'job-b', workspaceId: 'ws-1', repo: 'test-org/other-repo', status: 'queued', scope: 'full', sha: null, trigger: 'manual' },
    ];
    claimResults = [[{ id: 'job-a', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'running', scope: 'full' }]];
    const res = await POST(createRequest({ repos: ['test-org/test-repo'] }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.id).toBe('job-a');
    expect(data.job.status).toBe('running');
    expect(updateCalls[0].set.status).toBe('running');
    expect(updateCalls[0].set.startedAt).toBeInstanceOf(Date);
  });

  it('matches repos case-insensitively', async () => {
    queuedJobs = [
      { id: 'job-a', workspaceId: 'ws-1', repo: 'Test-Org/Test-Repo', status: 'queued', scope: 'full' },
    ];
    claimResults = [[{ id: 'job-a', workspaceId: 'ws-1', repo: 'Test-Org/Test-Repo', status: 'running', scope: 'full' }]];
    const res = await POST(createRequest({ repos: ['test-org/test-repo'] }));
    const data = await res.json();
    expect(data.job.id).toBe('job-a');
  });

  it('skips jobs for workspaces the account cannot access', async () => {
    queuedJobs = [
      { id: 'job-a', workspaceId: 'ws-other', repo: 'test-org/test-repo', status: 'queued', scope: 'full' },
    ];
    const res = await POST(createRequest({ repos: ['test-org/test-repo'] }));
    const data = await res.json();
    expect(data.job).toBeNull();
    expect(updateCalls.length).toBe(0);
  });

  it('returns job: null when no job matches the offered repos', async () => {
    queuedJobs = [
      { id: 'job-a', workspaceId: 'ws-1', repo: 'test-org/unrelated', status: 'queued', scope: 'full' },
    ];
    const res = await POST(createRequest({ repos: ['test-org/test-repo'] }));
    const data = await res.json();
    expect(data.job).toBeNull();
  });

  it('falls through to the next candidate when the atomic claim loses the race', async () => {
    queuedJobs = [
      { id: 'job-a', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'queued', scope: 'full' },
      { id: 'job-b', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'queued', scope: 'full' },
    ];
    // First claim (job-a) loses the atomic race → []; second (job-b) wins.
    claimResults = [[], [{ id: 'job-b', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'running', scope: 'full' }]];
    const res = await POST(createRequest({ repos: ['test-org/test-repo'] }));
    const data = await res.json();
    expect(data.job.id).toBe('job-b');
    expect(updateCalls.length).toBe(2);
  });

  // ── C12: dead-runner reclaim ───────────────────────────────────────────────

  it('C12: reclaims wedged jobs BEFORE scanning for candidates', async () => {
    // Every runner poll is a reclaim trigger. Reclaiming after the scan would
    // leave a requeued job sitting for a whole extra poll interval.
    await POST(createRequest({ repos: ['test-org/test-repo'] }));
    expect(mockReclaim).toHaveBeenCalled();
    expect(callLog.indexOf('reclaim')).toBeGreaterThanOrEqual(0);
    expect(callLog.indexOf('reclaim')).toBeLessThan(callLog.indexOf('select-candidates'));
  });

  it('C12: a job wedged in running by a dead runner is claimable in the same poll', async () => {
    // Reclaim requeues it, so the candidate scan in this very request sees it.
    reclaimSummary = { scanned: 1, requeued: ['job-wedged'], parked: [], escalated: [], stalled: [], raceLost: 0 };
    queuedJobs = [
      { id: 'job-wedged', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'queued', scope: 'full', attempts: 1 },
    ];
    claimResults = [[{ id: 'job-wedged', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'running', scope: 'full' }]];
    const res = await POST(createRequest({ repos: ['test-org/test-repo'] }));
    const data = await res.json();
    expect(data.job.id).toBe('job-wedged');
    expect(data.reclaimed).toEqual(['job-wedged']);
  });

  it('C12: stamps a lease on the claimed job so a dead runner cannot hold it forever', async () => {
    queuedJobs = [
      { id: 'job-a', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'queued', scope: 'full' },
    ];
    claimResults = [[{ id: 'job-a', status: 'running' }]];
    await POST(createRequest({ repos: ['test-org/test-repo'] }));
    const set = updateCalls[0].set;
    expect(set.leaseOwner).toBe('account-1');
    expect(set.leaseExpiresAt).toBeInstanceOf(Date);
    expect(set.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(set.heartbeatAt).toBeInstanceOf(Date);
  });

  it('honours an explicit runnerId as the lease owner', async () => {
    queuedJobs = [
      { id: 'job-a', workspaceId: 'ws-1', repo: 'test-org/test-repo', status: 'queued', scope: 'full' },
    ];
    claimResults = [[{ id: 'job-a', status: 'running' }]];
    await POST(createRequest({ repos: ['test-org/test-repo'], runnerId: 'runner-7' }));
    expect(updateCalls[0].set.leaseOwner).toBe('runner-7');
  });

  it('reports stalled full jobs on an empty claim so the queue is not silently dark', async () => {
    reclaimSummary = {
      scanned: 1,
      requeued: [],
      parked: [],
      escalated: [],
      stalled: [{ id: 'job-nobody', workspaceId: 'ws-1', repo: 'test-org/other', scope: 'full', ageMs: 9_000_000 }],
      raceLost: 0,
    };
    const res = await POST(createRequest({ repos: ['test-org/test-repo'] }));
    const data = await res.json();
    expect(data.job).toBeNull();
    expect(data.stalled.length).toBe(1);
    expect(data.stalled[0].id).toBe('job-nobody');
  });
});
