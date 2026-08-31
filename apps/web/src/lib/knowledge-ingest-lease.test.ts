process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Fake DB ──────────────────────────────────────────────────────────────────
// The reclaim path is deliberately select-then-CAS (no db.transaction — the
// neon-http driver can't do interactive transactions), so every decision is
// made in plain JS and is directly assertable here.
type Row = Record<string, any>;

let candidateRows: Row[] = [];
let updateCalls: Array<{ set: Row }> = [];
let updateResults: Row[][] = [];
let insertCalls: Array<{ values: Row }> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(candidateRows),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (set: Row) => ({
        where: () => ({
          returning: () => {
            updateCalls.push({ set });
            // Default: CAS wins. updateResults lets a test simulate losing the race.
            return Promise.resolve(updateResults.shift() ?? [{ id: 'cas-ok' }]);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Row) => {
        insertCalls.push({ values });
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ id: 'full-recovery-1' }]),
          }),
        };
      },
    }),
  },
}));

import {
  classifyIngestJobLiveness,
  reclaimStaleIngestJobs,
  recoverBlockedDiffJob,
  MAX_INGEST_ATTEMPTS,
  FULL_LEASE_MS,
  RUNNING_NO_LEASE_STALL_MS,
  QUEUED_DIFF_STALL_MS,
  QUEUED_FULL_STALL_MS,
} from './knowledge-ingest-lease';

const NOW = new Date('2026-08-31T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function job(overrides: Row = {}): any {
  return {
    id: 'job-1',
    workspaceId: 'ws-1',
    repo: 'test-org/test-repo',
    scope: 'full',
    status: 'running',
    attempts: 0,
    leaseOwner: 'runner-1',
    leaseExpiresAt: new Date(NOW.getTime() + FULL_LEASE_MS),
    heartbeatAt: NOW,
    startedAt: NOW,
    createdAt: NOW,
    sha: 'sha-1',
    prNumber: null,
    trigger: 'manual',
    ...overrides,
  };
}

beforeEach(() => {
  candidateRows = [];
  updateCalls = [];
  updateResults = [];
  insertCalls = [];
});

// ── classifyIngestJobLiveness (pure) ─────────────────────────────────────────
describe('classifyIngestJobLiveness', () => {
  it('treats done/error rows as terminal', () => {
    expect(classifyIngestJobLiveness(job({ status: 'done' }), NOW)).toBe('terminal');
    expect(classifyIngestJobLiveness(job({ status: 'error' }), NOW)).toBe('terminal');
  });

  it('treats a running job with a live lease as live', () => {
    expect(classifyIngestJobLiveness(job(), NOW)).toBe('live');
  });

  it('C12: a running job whose lease lapsed is reclaimable, not live', () => {
    expect(
      classifyIngestJobLiveness(job({ leaseExpiresAt: ago(1000) }), NOW),
    ).toBe('reclaimable');
  });

  it('C12: a legacy running row with no lease is governed by startedAt', () => {
    // Pre-migration rows carry NULL lease columns — they must NOT be treated as
    // leased-forever, and must NOT be reclaimed the instant they start either.
    expect(
      classifyIngestJobLiveness(job({ leaseExpiresAt: null, startedAt: ago(1000) }), NOW),
    ).toBe('live');
    expect(
      classifyIngestJobLiveness(
        job({ leaseExpiresAt: null, startedAt: ago(RUNNING_NO_LEASE_STALL_MS + 1000) }),
        NOW,
      ),
    ).toBe('reclaimable');
  });

  it('falls back to createdAt when a running row has neither lease nor startedAt', () => {
    expect(
      classifyIngestJobLiveness(
        job({ leaseExpiresAt: null, startedAt: null, createdAt: ago(RUNNING_NO_LEASE_STALL_MS + 1000) }),
        NOW,
      ),
    ).toBe('reclaimable');
  });

  it('marks a lapsed lease as exhausted once the attempt ceiling is hit', () => {
    expect(
      classifyIngestJobLiveness(
        job({ leaseExpiresAt: ago(1000), attempts: MAX_INGEST_ATTEMPTS }),
        NOW,
      ),
    ).toBe('exhausted');
  });

  it('C13: a queued diff job nobody started is stalled once past its window', () => {
    expect(
      classifyIngestJobLiveness(
        job({ status: 'queued', scope: 'diff', startedAt: null, createdAt: ago(1000), heartbeatAt: null }),
        NOW,
      ),
    ).toBe('live');
    expect(
      classifyIngestJobLiveness(
        job({
          status: 'queued',
          scope: 'diff',
          startedAt: null,
          heartbeatAt: null,
          createdAt: ago(QUEUED_DIFF_STALL_MS + 1000),
        }),
        NOW,
      ),
    ).toBe('stalled');
  });

  it('measures queued age from heartbeatAt when present, so a requeue resets the clock', () => {
    expect(
      classifyIngestJobLiveness(
        job({
          status: 'queued',
          scope: 'diff',
          startedAt: null,
          createdAt: ago(QUEUED_DIFF_STALL_MS * 10),
          heartbeatAt: NOW,
        }),
        NOW,
      ),
    ).toBe('live');
  });

  it('a queued full job stalls on its own (longer) window', () => {
    expect(
      classifyIngestJobLiveness(
        job({ status: 'queued', scope: 'full', startedAt: null, heartbeatAt: null, createdAt: ago(QUEUED_DIFF_STALL_MS + 1000) }),
        NOW,
      ),
    ).toBe('live');
    expect(
      classifyIngestJobLiveness(
        job({ status: 'queued', scope: 'full', startedAt: null, heartbeatAt: null, createdAt: ago(QUEUED_FULL_STALL_MS + 1000) }),
        NOW,
      ),
    ).toBe('stalled');
  });
});

// ── reclaimStaleIngestJobs ───────────────────────────────────────────────────
describe('reclaimStaleIngestJobs', () => {
  it('leaves live jobs completely alone', async () => {
    candidateRows = [job(), job({ id: 'job-2', status: 'queued', scope: 'diff', heartbeatAt: null, createdAt: NOW })];
    const res = await reclaimStaleIngestJobs({ now: NOW });
    expect(updateCalls.length).toBe(0);
    expect(insertCalls.length).toBe(0);
    expect(res.requeued).toEqual([]);
    expect(res.parked).toEqual([]);
    expect(res.scanned).toBe(2);
  });

  it('C12: requeues a running job whose lease lapsed and bumps attempts', async () => {
    candidateRows = [job({ id: 'wedged', leaseExpiresAt: ago(60_000), attempts: 0 })];
    const res = await reclaimStaleIngestJobs({ now: NOW });
    expect(res.requeued).toEqual(['wedged']);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].set.status).toBe('queued');
    expect(updateCalls[0].set.attempts).toBe(1);
    expect(updateCalls[0].set.leaseOwner).toBeNull();
    expect(updateCalls[0].set.leaseExpiresAt).toBeNull();
    // heartbeat is bumped so the requeued row isn't instantly re-classified stalled
    expect(updateCalls[0].set.heartbeatAt).toBeInstanceOf(Date);
  });

  it('reports nothing when the CAS loses the race (another reclaimer won)', async () => {
    candidateRows = [job({ id: 'wedged', leaseExpiresAt: ago(60_000) })];
    updateResults = [[]]; // UPDATE ... WHERE status='running' AND attempts=0 matched nothing
    const res = await reclaimStaleIngestJobs({ now: NOW });
    expect(res.requeued).toEqual([]);
    expect(res.raceLost).toBe(1);
  });

  it('parks an exhausted job as error so the idempotency index stops blocking re-enqueue', async () => {
    candidateRows = [job({ id: 'dead', scope: 'full', leaseExpiresAt: ago(60_000), attempts: MAX_INGEST_ATTEMPTS })];
    const res = await reclaimStaleIngestJobs({ now: NOW });
    expect(res.parked).toEqual(['dead']);
    expect(updateCalls[0].set.status).toBe('error');
    expect(String(updateCalls[0].set.error)).toContain('lease');
    expect(updateCalls[0].set.finishedAt).toBeInstanceOf(Date);
  });

  it('C13: escalates a stalled queued diff job to a full recovery job and parks it', async () => {
    candidateRows = [
      job({
        id: 'lost-diff',
        scope: 'diff',
        status: 'queued',
        prNumber: 42,
        startedAt: null,
        heartbeatAt: null,
        createdAt: ago(QUEUED_DIFF_STALL_MS + 1000),
      }),
    ];
    const res = await reclaimStaleIngestJobs({ now: NOW });
    expect(res.parked).toEqual(['lost-diff']);
    expect(res.escalated).toEqual(['lost-diff']);
    // A full-scope recovery job is enqueued for the same workspace+repo. The
    // runner claim path already picks those up, so the lost diff's file
    // contents come back without any new poller.
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values.scope).toBe('full');
    expect(insertCalls[0].values.status).toBe('queued');
    expect(insertCalls[0].values.workspaceId).toBe('ws-1');
    expect(insertCalls[0].values.repo).toBe('test-org/test-repo');
  });

  it('escalates an exhausted diff job too', async () => {
    candidateRows = [
      job({ id: 'dead-diff', scope: 'diff', leaseExpiresAt: ago(60_000), attempts: MAX_INGEST_ATTEMPTS }),
    ];
    const res = await reclaimStaleIngestJobs({ now: NOW });
    expect(res.parked).toEqual(['dead-diff']);
    expect(res.escalated).toEqual(['dead-diff']);
    expect(insertCalls.length).toBe(1);
  });

  it('reports a stalled full job without touching it — a runner may still show up', async () => {
    candidateRows = [
      job({ id: 'no-runner', scope: 'full', status: 'queued', startedAt: null, heartbeatAt: null, createdAt: ago(QUEUED_FULL_STALL_MS + 5000) }),
    ];
    const res = await reclaimStaleIngestJobs({ now: NOW });
    expect(updateCalls.length).toBe(0);
    expect(insertCalls.length).toBe(0);
    expect(res.stalled.length).toBe(1);
    expect(res.stalled[0].id).toBe('no-runner');
    expect(res.stalled[0].ageMs).toBeGreaterThan(QUEUED_FULL_STALL_MS);
  });
});

// ── recoverBlockedDiffJob ────────────────────────────────────────────────────
describe('recoverBlockedDiffJob', () => {
  it('C13: returns the wedged row id so a webhook redelivery re-runs it', async () => {
    candidateRows = [job({ id: 'wedged-diff', scope: 'diff', leaseExpiresAt: ago(60_000), attempts: 0 })];
    const id = await recoverBlockedDiffJob(
      { workspaceId: 'ws-1', repo: 'test-org/test-repo', sha: 'sha-1' },
      NOW,
    );
    expect(id).toBe('wedged-diff');
    expect(updateCalls[0].set.status).toBe('queued');
  });

  it('returns null when the blocking row is genuinely live', async () => {
    candidateRows = [job({ id: 'live-diff', scope: 'diff' })];
    const id = await recoverBlockedDiffJob(
      { workspaceId: 'ws-1', repo: 'test-org/test-repo', sha: 'sha-1' },
      NOW,
    );
    expect(id).toBeNull();
    expect(updateCalls.length).toBe(0);
  });

  it('returns null and escalates when the blocking row is past the attempt ceiling', async () => {
    candidateRows = [
      job({ id: 'dead-diff', scope: 'diff', leaseExpiresAt: ago(60_000), attempts: MAX_INGEST_ATTEMPTS }),
    ];
    const id = await recoverBlockedDiffJob(
      { workspaceId: 'ws-1', repo: 'test-org/test-repo', sha: 'sha-1' },
      NOW,
    );
    expect(id).toBeNull();
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values.scope).toBe('full');
  });

  it('returns null when there is no matching row at all', async () => {
    candidateRows = [];
    const id = await recoverBlockedDiffJob(
      { workspaceId: 'ws-1', repo: 'test-org/test-repo', sha: 'sha-1' },
      NOW,
    );
    expect(id).toBeNull();
  });
});
