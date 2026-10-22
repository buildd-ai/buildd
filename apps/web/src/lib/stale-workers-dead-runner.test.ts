import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { GroupingNormalisedPgDialect } from '@buildd/core/db/sql-grouping';
import { RUNNER_STALE_CUTOFF_MS } from '@buildd/shared';

/**
 * Regression for the Oct 22 shape: a runner (a Mac) went offline with two
 * workers running while the account's two other runners kept heartbeating.
 * The offline-runner rule was keyed on the ACCOUNT ("is any runner alive?"),
 * so the dead runner's workers never became orphans; and the orphan predicate
 * read `workers.updated_at`, which every agent message, idle probe and
 * description notice bumps, so the generic reap never fired either. Both
 * tasks read RUNNING, the dead worker's path lease deferred other tasks, and
 * setting the tasks back to `pending` did not free them: the claim guard
 * refuses a task with a live-status worker row.
 *
 * Same technique as stale-workers-scope.test.ts: only the db client is
 * stubbed, so the real drizzle builders render the WHERE the reaper issues.
 */
const workerUpdates: Array<{ set: any; where: any }> = [];
const taskUpdates: Array<{ set: any; where: any }> = [];
const accountUpdates: Array<{ set: any; where: any }> = [];
const workerQueries: any[] = [];
const heartbeatQueries: any[] = [];
let heartbeatRows: any[] = [];
let heartbeatReadFails = false;
let candidateRows: any[] = [];
let taskRowsById = new Map<string, any>();

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workerHeartbeats: {
        findMany: async (args: any) => {
          heartbeatQueries.push(args);
          if (heartbeatReadFails) throw new Error('heartbeat table unreachable');
          return heartbeatRows;
        },
        findFirst: async () => null,
      },
      workers: {
        findMany: async (args: any) => {
          workerQueries.push(args);
          // Only the orphan-candidate query selects the runner identity columns.
          if (args.columns?.localUiUrl) return candidateRows;
          // "Other live workers on the task" and "failed workers so far": none.
          return [];
        },
      },
      tasks: {
        findFirst: async (args: any) => {
          const id = dialect.sqlToQuery(args.where).params.find((p: unknown) => typeof p === 'string' && taskRowsById.has(p as string)) as string | undefined;
          return id ? taskRowsById.get(id) : null;
        },
        findMany: async (args: any) => {
          const params = dialect.sqlToQuery(args.where).params as string[];
          return [...taskRowsById.values()].filter(t => params.includes(t.id)).map(t => ({ id: t.id, workspaceId: t.workspaceId }));
        },
      },
    },
    update: (table: any) => ({
      set: (set: any) => ({
        where: (where: any) => {
          const sink = table === schema.workers ? workerUpdates : table === schema.accounts ? accountUpdates : taskUpdates;
          sink.push({ set, where });
          return Object.assign(Promise.resolve(), { returning: async () => [{ id: 'row' }] });
        },
      }),
    }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));

const mockReleaseAndNotify = mock(async (_taskId: string, _reason: string) => {});
mock.module('@/lib/path-claim-release', () => ({ releaseAndNotify: mockReleaseAndNotify }));
const mockResolveCompletedTask = mock(async (_taskId: string, _ws: string) => {});
mock.module('@/lib/task-dependencies', () => ({ resolveCompletedTask: mockResolveCompletedTask }));
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: any) => {});
mock.module('@/lib/dispatch-authority', () => ({ wakeTask: mockWakeTask }));
mock.module('@/lib/workflow/authority', () => ({
  kernelDeliveryById: async () => null,
  reapedOwnerAttemptIsCurrent: async () => true,
  reapedOwnerAttemptIsCurrentSql: () => ({}),
}));
mock.module('@/lib/worker-deliverables', () => ({
  checkWorkerDeliverables: () => ({ hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none' }),
  getWorkerDeliverableArtifactCount: async () => 0,
  getLatestWorkerArtifactWithStructuredOutput: async () => null,
}));
mock.module('@/lib/work-changed', () => ({ noteWorkChanged: () => {} }));
mock.module('@/lib/interactive-detach', () => ({
  detachInteractiveWorkersOfEndedTasks: async () => {},
  releaseConcurrencySeats: async () => {},
}));
mock.module('@/lib/auto-merge', () => ({ escalateReviewContractFailure: async () => {} }));

import * as schema from '@buildd/core/db/schema';
import { failWorkersOfOfflineRunners, heartbeatRowHasNoLiveWorkers, HEARTBEAT_STALE_MS } from './stale-workers';

const dialect = new GroupingNormalisedPgDialect();
const render = (fragment: any) => dialect.sqlToQuery(fragment).sql.replace(/\s+/g, ' ').trim().toLowerCase();

const NOW = new Date('2026-10-22T21:20:00.000Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const ACCOUNT = 'acct-1';
const DEAD = 'headless://TWC-mac';
const ALPHA = 'http://alpha.local:8766';
const BETA = 'http://beta.local:8766';

function runnerRow(localUiUrl: string, lastHeartbeatAt: Date, labels: Record<string, string> = {}) {
  return { accountId: ACCOUNT, localUiUrl, lastHeartbeatAt, environment: { labels } };
}

function worker(id: string, taskId: string, runner: string, over: Record<string, unknown> = {}) {
  return {
    id, taskId, accountId: ACCOUNT, runner, localUiUrl: runner,
    status: 'running', startedAt: min(300), createdAt: min(300), updatedAt: min(180),
    leaseExpiresAt: min(140), turns: 40, costUsd: '1.200000', inputTokens: 1000, outputTokens: 500,
    prUrl: null, prNumber: null, commitCount: 0, branch: `buildd/${taskId}`, error: null,
    ...over,
  };
}

function task(id: string, over: Record<string, unknown> = {}) {
  return { id, workspaceId: 'ws-1', status: 'in_progress', category: 'feature', context: {}, kind: 'engineering', parentTaskId: null, ...over };
}

function reset() {
  workerUpdates.length = 0;
  taskUpdates.length = 0;
  accountUpdates.length = 0;
  workerQueries.length = 0;
  heartbeatQueries.length = 0;
  heartbeatRows = [];
  heartbeatReadFails = false;
  candidateRows = [];
  taskRowsById = new Map();
  mockReleaseAndNotify.mockClear();
  mockWakeTask.mockClear();
  mockResolveCompletedTask.mockClear();
}

const failedIds = () => workerUpdates.filter(u => u.set.status === 'failed').flatMap(u => dialect.sqlToQuery(u.where).params as string[]);

describe('a dead runner is reaped while the account\'s other runners are alive', () => {
  beforeEach(reset);

  it('Oct 22: three runners, one silent past the cutoff with two running workers — both are reaped, their leases released, their tasks requeued', async () => {
    heartbeatRows = [
      runnerRow(DEAD, new Date(NOW.getTime() - RUNNER_STALE_CUTOFF_MS - 60_000), { name: 'studio' }),
      runnerRow(ALPHA, min(0.5)),
      runnerRow(BETA, min(0.75)),
    ];
    candidateRows = [
      // A message a person sent it a minute ago bumped updated_at: not liveness.
      worker('w-dead-1', 'task-mission-page', DEAD, { updatedAt: min(1) }),
      worker('w-dead-2', 'task-review-fix', DEAD),
      // Under a live runner: whatever its row says, its runner vouches for it.
      worker('w-live', 'task-alpha', ALPHA, { leaseExpiresAt: null }),
      // Names no runner a heartbeat row could match: judged by the account as before.
      worker('w-legacy', 'task-legacy', 'runner', { localUiUrl: null, leaseExpiresAt: null }),
    ];
    for (const id of ['task-mission-page', 'task-review-fix', 'task-alpha', 'task-legacy']) taskRowsById.set(id, task(id));

    expect(await failWorkersOfOfflineRunners({ accountIds: [ACCOUNT] }, NOW)).toBe(2);

    expect(failedIds().sort()).toEqual(['w-dead-1', 'w-dead-2']);
    const booked = workerUpdates.find(u => u.set.status === 'failed')!.set;
    expect(booked.exitCause).toBe('infra_failure');
    expect(booked.error).toBe('Worker runner went offline (heartbeat expired)');

    // Path leases: released for the dead runner's tasks only, as abandoned work.
    const released = mockReleaseAndNotify.mock.calls.map(c => c[0]).sort();
    expect(released).toEqual(['task-mission-page', 'task-review-fix']);
    expect(mockReleaseAndNotify.mock.calls.every(c => c[1] === 'abandoned')).toBe(true);

    // Both tasks go back to the queue as an infra failure (backoff, no retry charge), and are woken.
    const requeued = taskUpdates.filter(u => u.set.status === 'pending');
    expect(requeued).toHaveLength(2);
    for (const u of requeued) {
      expect(u.set.claimedBy).toBeNull();
      expect(u.set.startAt).toBeInstanceOf(Date);
    }
    expect(mockWakeTask.mock.calls.map(c => c[0]).sort()).toEqual(['task-mission-page', 'task-review-fix']);
  });

  it('a task a person set back to pending while its only worker was orphaned becomes claimable: the worker row is failed and the task stays pending', async () => {
    heartbeatRows = [runnerRow(DEAD, min(200)), runnerRow(ALPHA, min(1))];
    candidateRows = [worker('w-dead', 'task-reset', DEAD)];
    // The person already reset it; the live-status worker row was what the claim guard refused.
    taskRowsById.set('task-reset', task('task-reset', { status: 'pending' }));

    expect(await failWorkersOfOfflineRunners({ accountIds: [ACCOUNT] }, NOW)).toBe(1);
    expect(failedIds()).toEqual(['w-dead']);
    const requeue = taskUpdates.find(u => u.set.status === 'pending');
    expect(requeue).toBeDefined();
    expect(requeue!.set.claimedBy).toBeNull();
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-reset', 'abandoned');
  });

  it('the orphan clock is the runner\'s own evidence (lease, row age), never updated_at', async () => {
    heartbeatRows = [runnerRow(DEAD, min(200)), runnerRow(ALPHA, min(1))];
    candidateRows = [];
    await failWorkersOfOfflineRunners({ accountIds: [ACCOUNT] }, NOW);

    const orphanQuery = workerQueries.find(q => q.columns?.localUiUrl);
    expect(orphanQuery).toBeDefined();
    const text = render(orphanQuery.where);
    const cutoffIso = new Date(NOW.getTime() - HEARTBEAT_STALE_MS).toISOString();
    expect(text).not.toContain('"workers"."updated_at"');
    expect(text).toContain('"workers"."lease_expires_at" is null or "workers"."lease_expires_at" <');
    expect(text).toContain('"workers"."created_at" <');
    expect(text).toMatch(/"workers"\."account_id" = \$\d/);
    expect(text).toMatch(/"workers"\."runner" <> \$\d/);
    expect(dialect.sqlToQuery(orphanQuery.where).params).toEqual(expect.arrayContaining([ACCOUNT, 'mcp', cutoffIso]));
  });

  it('every runner on the account inside the cutoff: nothing is queried, nothing is failed', async () => {
    heartbeatRows = [runnerRow(ALPHA, min(1)), runnerRow(BETA, min(30))];
    candidateRows = [worker('w-x', 'task-x', ALPHA)];
    expect(await failWorkersOfOfflineRunners({ accountIds: [ACCOUNT] }, NOW)).toBe(0);
    expect(workerQueries).toHaveLength(0);
    expect(workerUpdates).toHaveLength(0);
  });

  it('a runner inside the cutoff keeps its workers even when its row is far past the presence windows', async () => {
    heartbeatRows = [runnerRow(DEAD, min(200)), runnerRow(ALPHA, min(120))];
    candidateRows = [worker('w-slow', 'task-slow', ALPHA), worker('w-dead', 'task-dead', DEAD)];
    taskRowsById.set('task-dead', task('task-dead'));
    expect(await failWorkersOfOfflineRunners({ accountIds: [ACCOUNT] }, NOW)).toBe(1);
    expect(failedIds()).toEqual(['w-dead']);
  });

  it('no heartbeat row on the account at all: every candidate is an orphan, as before (AC-7)', async () => {
    heartbeatRows = [];
    candidateRows = [worker('w-a', 'task-a', ALPHA), worker('w-legacy', 'task-b', 'runner', { localUiUrl: null, leaseExpiresAt: null })];
    taskRowsById.set('task-a', task('task-a'));
    taskRowsById.set('task-b', task('task-b'));
    expect(await failWorkersOfOfflineRunners({ accountIds: [ACCOUNT] }, NOW)).toBe(2);
    expect(failedIds().sort()).toEqual(['w-a', 'w-legacy']);
  });

  it('a runner whose row is gone is dead once its worker lease lapsed; without a lease there is nothing to judge by', async () => {
    // Rows outlive their live workers (heartbeatRowHasNoLiveWorkers guards both
    // deletion sweeps), so a missing row is a legacy deletion; the sweep still
    // reads it right whenever it looks.
    heartbeatRows = [runnerRow(ALPHA, min(1)), runnerRow(BETA, min(400))];
    candidateRows = [
      worker('w-gone', 'task-gone', 'http://gone.local:8766', { leaseExpiresAt: min(200) }),
      // Same missing row, but a runner build that never renewed a lease: no evidence, kept.
      worker('w-gone-old', 'task-gone-old', 'http://gone-old.local:8766', { leaseExpiresAt: null }),
    ];
    taskRowsById.set('task-gone', task('task-gone'));
    expect(await failWorkersOfOfflineRunners({ accountIds: [ACCOUNT] }, NOW)).toBe(1);
    expect(failedIds()).toEqual(['w-gone']);
  });

  it('a heartbeat read that fails is not evidence of death: the sweep errors out and fails nothing', async () => {
    heartbeatReadFails = true;
    candidateRows = [worker('w-dead', 'task-dead', DEAD)];
    await expect(failWorkersOfOfflineRunners({ accountIds: [ACCOUNT] }, NOW)).rejects.toThrow('heartbeat table unreachable');
    expect(workerUpdates).toHaveLength(0);
  });

  it('reads one account\'s heartbeat rows, any age, keyed on the account alone', async () => {
    heartbeatRows = [runnerRow(ALPHA, min(1))];
    await failWorkersOfOfflineRunners({ accountIds: [ACCOUNT, ACCOUNT] }, NOW);
    expect(heartbeatQueries).toHaveLength(1);
    const text = render(heartbeatQueries[0].where);
    expect(text).toMatch(/^"worker_heartbeats"\."account_id" = \$1$/);
    expect(text).not.toContain('last_heartbeat_at');
    expect(text).not.toContain('team_id');
    expect(dialect.sqlToQuery(heartbeatQueries[0].where).params).toEqual([ACCOUNT]);
    expect(accountUpdates).toHaveLength(0);
  });

  it('a heartbeat row still named by a live-status worker is never deleted, so a row outlives its workers', () => {
    const text = render(heartbeatRowHasNoLiveWorkers());
    expect(text).toMatch(/^not exists \( select 1 from "workers"/);
    expect(text).toContain('"worker_heartbeats"."account_id"');
    expect(text).toContain('coalesce(w_hb.local_ui_url, w_hb.runner) = "worker_heartbeats"."local_ui_url"');
    expect(text).toContain("w_hb.status in ('running', 'starting', 'idle', 'waiting_input')");
  });
});
