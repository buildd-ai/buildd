import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { GroupingNormalisedPgDialect } from '@buildd/core/db/sql-grouping';
import { WORKER_LEASE_TTL_MS } from '@buildd/shared';

/**
 * A live runner vouches for each worker it holds (failWorkersUnvouchedByRunner).
 *
 * 2026-10-23: an agent killed its own Windows runner; the restart settled the
 * worker locally (error) without the server hearing, and the runner went on
 * heartbeating every minute. R-38 keeps a worker of a heartbeating runner
 * un-reaped, and the offline-runner rule judges only the runner, so the row
 * read `running` for nine hours. The runner's heartbeat names every worker it
 * runs or holds paused; one it stopped naming long enough is failed.
 */
const workerQueries: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workers: { findMany: async (args: any) => { workerQueries.push(args); return []; } } },
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  },
}));
mock.module('@/lib/path-claim-release', () => ({ releaseAndNotify: async () => {} }));
mock.module('@/lib/task-dependencies', () => ({ resolveCompletedTask: async () => {} }));
mock.module('@/lib/dispatch-authority', () => ({ wakeTask: async () => {} }));
mock.module('@/lib/workflow/authority', () => ({
  kernelDeliveryById: async () => null,
  reapedOwnerAttemptIsCurrent: async () => true,
  reapedOwnerAttemptIsCurrentSql: () => ({}),
}));
mock.module('@/lib/work-changed', () => ({ noteWorkChanged: () => {} }));
mock.module('@/lib/interactive-detach', () => ({ detachInteractiveWorkersOfEndedTasks: async () => {}, releaseConcurrencySeats: async () => {} }));
mock.module('@/lib/auto-merge', () => ({ escalateReviewContractFailure: async () => {} }));

import { failWorkersUnvouchedByRunner, RUNNER_NO_LONGER_REPORTS_ERROR, type UnvouchedCandidate, type UnvouchedDeps } from './stale-workers';
import { UNVOUCHED_GRACE_MS, runnerLiveness, offlineRunnerWaitLine, type RunnerBeat } from './runner-offline';

const NOW = new Date('2026-10-23T11:00:00.000Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const ACCOUNT = 'acct-1';
const RUNNER = 'headless://DESKTOP-WIN';
const OTHER = 'http://other.local:8766';

type Row = UnvouchedCandidate & { status: string; localUiUrl: string; leaseExpiresAt: Date | null };

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id, taskId: `task-${id}`, accountId: ACCOUNT, runner: RUNNER, localUiUrl: RUNNER, status: 'running',
    startedAt: min(600), turns: 40, costUsd: '1.2', inputTokens: 1000, outputTokens: 500,
    // Last named about nine hours ago: lease = that write + TTL + write interval.
    leaseExpiresAt: min(540),
    prUrl: null, prNumber: null, commitCount: 0, branch: `buildd/${id}`, error: null,
    ...over,
  };
}

/** An in-memory worker table with the same predicate and CAS as the real one. */
function harness(rows: Row[]) {
  const resolved: string[] = [];
  const failed: Array<{ id: string; exitCause: string; error: string }> = [];
  const live = new Set(['running', 'starting', 'waiting_input']);
  const matches = (r: Row, runner: string, leaseBefore: Date) =>
    r.accountId === ACCOUNT && (r.localUiUrl ?? r.runner) === runner && live.has(r.status)
    && r.leaseExpiresAt !== null && r.leaseExpiresAt < leaseBefore;
  const deps: UnvouchedDeps = {
    async findCandidates({ runner, vouched, leaseBefore }) {
      return rows.filter(r => matches(r, runner, leaseBefore) && !vouched.includes(r.id));
    },
    async fail(groups, leaseBefore) {
      const ids: string[] = [];
      for (const g of groups) for (const id of g.ids) {
        const r = rows.find(x => x.id === id)!;
        if (!live.has(r.status) || !(r.leaseExpiresAt && r.leaseExpiresAt < leaseBefore)) continue;
        r.status = 'failed';
        failed.push({ id, exitCause: g.exitCause, error: g.error });
        ids.push(id);
      }
      return ids;
    },
    releaseSeats: async () => {},
    resolveTasks: async (ws) => { resolved.push(...ws.map(w => w.taskId!)); },
    log: () => {},
  };
  return { deps, resolved, failed };
}

describe('failWorkersUnvouchedByRunner', () => {
  beforeEach(() => { workerQueries.length = 0; });

  it('fails a running worker its live runner stopped naming, and requeues its task as an infra failure', async () => {
    const rows = [row('stranded')];
    const h = harness(rows);
    const n = await failWorkersUnvouchedByRunner({ accountId: ACCOUNT, runner: RUNNER, vouched: [], now: NOW }, h.deps);
    expect(n).toBe(1);
    expect(h.failed).toEqual([{ id: 'stranded', exitCause: 'infra_failure', error: RUNNER_NO_LONGER_REPORTS_ERROR }]);
    expect(h.resolved).toEqual(['task-stranded']);
  });

  it('R-38: a worker the beat names is never touched, paused or running, however old its lease', async () => {
    const rows = [row('running-named'), row('paused-named', { status: 'waiting_input' })];
    const h = harness(rows);
    const n = await failWorkersUnvouchedByRunner({ accountId: ACCOUNT, runner: RUNNER, vouched: ['running-named', 'paused-named'], now: NOW }, h.deps);
    expect(n).toBe(0);
    expect(rows.map(r => r.status)).toEqual(['running', 'waiting_input']);
  });

  it('a paused worker the runner forgot is failed too', async () => {
    const h = harness([row('paused-forgotten', { status: 'waiting_input' })]);
    expect(await failWorkersUnvouchedByRunner({ accountId: ACCOUNT, runner: RUNNER, vouched: [], now: NOW }, h.deps)).toBe(1);
  });

  it('inside the grace nothing is failed: an unnamed worker whose lease lapsed only just now stays', async () => {
    const h = harness([row('just-unnamed', { leaseExpiresAt: new Date(NOW.getTime() - UNVOUCHED_GRACE_MS + 60_000) })]);
    expect(await failWorkersUnvouchedByRunner({ accountId: ACCOUNT, runner: RUNNER, vouched: [], now: NOW }, h.deps)).toBe(0);
  });

  it('a lease the runner still renews is never past the grace', () => {
    // A named worker's lease is written at least every write interval to
    // write time + TTL + interval; never before now, let alone the grace.
    expect(WORKER_LEASE_TTL_MS).toBeGreaterThan(0);
    expect(UNVOUCHED_GRACE_MS).toBeGreaterThan(0);
  });

  it('a worker with no lease on record (a build that never renews) is no evidence', async () => {
    const h = harness([row('no-lease', { leaseExpiresAt: null })]);
    expect(await failWorkersUnvouchedByRunner({ accountId: ACCOUNT, runner: RUNNER, vouched: [], now: NOW }, h.deps)).toBe(0);
  });

  it("another runner's workers are not this beat's to judge", async () => {
    const h = harness([row('elsewhere', { runner: OTHER, localUiUrl: OTHER })]);
    expect(await failWorkersUnvouchedByRunner({ accountId: ACCOUNT, runner: RUNNER, vouched: [], now: NOW }, h.deps)).toBe(0);
  });

  it('a lease renewed between the read and the write wins the CAS', async () => {
    const rows = [row('renewed')];
    const h = harness(rows);
    const fail = h.deps.fail;
    h.deps.fail = async (groups, leaseBefore, now) => { rows[0].leaseExpiresAt = new Date(NOW.getTime() + 600_000); return fail(groups, leaseBefore, now); };
    expect(await failWorkersUnvouchedByRunner({ accountId: ACCOUNT, runner: RUNNER, vouched: [], now: NOW }, h.deps)).toBe(0);
    expect(h.resolved).toEqual([]);
  });

  it('a row the runner never started stays a never-started row, not charged to the task', async () => {
    const h = harness([row('unstarted', { startedAt: null, status: 'starting' })]);
    await failWorkersUnvouchedByRunner({ accountId: ACCOUNT, runner: RUNNER, vouched: [], now: NOW }, h.deps);
    expect(h.failed[0].exitCause).toBe('never_started');
  });

  it('the real query judges by the lease and the runner key, never updated_at, and excludes the named ids', async () => {
    await failWorkersUnvouchedByRunner({ accountId: ACCOUNT, runner: RUNNER, vouched: ['w-named'], now: NOW });
    expect(workerQueries).toHaveLength(1);
    const q = new GroupingNormalisedPgDialect().sqlToQuery(workerQueries[0].where);
    const sql = q.sql.toLowerCase();
    expect(sql).toContain('coalesce');
    expect(sql).toContain('lease_expires_at');
    expect(sql).toContain('not in');
    expect(sql).not.toContain('updated_at');
    expect(q.params).toContain(RUNNER);
    expect(q.params).toContain('w-named');
  });
});

describe('runnerLiveness: unvouched', () => {
  const beats: RunnerBeat[] = [{ accountId: ACCOUNT, localUiUrl: RUNNER, lastHeartbeatAt: min(1), environment: { labels: null } } as RunnerBeat];

  it('a live runner whose lease on this worker lapsed past the grace no longer reports it', () => {
    const l = runnerLiveness({ runner: RUNNER, localUiUrl: RUNNER, accountId: ACCOUNT, leaseExpiresAt: min(540) }, beats, NOW);
    expect(l.verdict).toBe('unvouched');
    expect(offlineRunnerWaitLine(l)).toMatch(/^runner \S+ no longer reports this worker/);
  });

  it('a live runner still renewing the lease is live', () => {
    const l = runnerLiveness({ runner: RUNNER, localUiUrl: RUNNER, accountId: ACCOUNT, leaseExpiresAt: new Date(NOW.getTime() + 300_000) }, beats, NOW);
    expect(l.verdict).toBe('live');
  });

  it('no lease is no evidence: live', () => {
    const l = runnerLiveness({ runner: RUNNER, localUiUrl: RUNNER, accountId: ACCOUNT, leaseExpiresAt: null }, beats, NOW);
    expect(l.verdict).toBe('live');
  });
});
