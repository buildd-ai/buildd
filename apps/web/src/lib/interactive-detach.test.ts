import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { accounts, tasks, workers } from '@buildd/core/db/schema';

/**
 * The detach primitive against a small in-memory stand-in for the three rows
 * it touches. The worker write's compare-and-swap is reproduced here (live +
 * interactive → wins once), because exactly-once seat release is the property
 * under test; the WHERE it is issued with is rendered with the real dialect
 * and checked separately, so the stand-in cannot drift from the SQL.
 */

const dialect = new PgDialect();
const LIVE = new Set(['idle', 'running', 'starting', 'waiting_input']);

type Row = Record<string, any>;
let workerRow: Row | null;
let taskRow: Row | null;
let account: Row;
let sweepRows: Array<{ id: string; taskStatus: string }>;
let workerWheres: any[];
let sweepWheres: any[];
let taskWrites: Row[];
let workerReadOverride: Row | null;
let sweepThrows: boolean;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: async () => workerReadOverride ?? (workerRow ? { ...workerRow } : null) },
      tasks: { findFirst: async () => (taskRow ? { ...taskRow } : null) },
    },
    update: (table: unknown) => ({
      set: (vals: Row) => ({
        where: (where: unknown) => {
          const run = async () => {
            if (table === workers) {
              workerWheres.push(where);
              if (!workerRow || workerRow.runner !== 'mcp' || !LIVE.has(workerRow.status)) return [];
              const { milestones: _m, ...rest } = vals;
              Object.assign(workerRow, rest);
              return [{ id: workerRow.id }];
            }
            if (table === accounts) {
              // GREATEST(active - n, 0), oauth only.
              if (account.authType === 'oauth') account.activeSessions = Math.max(account.activeSessions - 1, 0);
              return [];
            }
            if (table === tasks) {
              taskWrites.push(vals);
              if (taskRow && !['completed', 'failed', 'cancelled', 'pending'].includes(taskRow.status)) {
                Object.assign(taskRow, vals);
                return [{ id: taskRow.id }];
              }
              return [];
            }
            return [];
          };
          const p = run();
          return Object.assign(p, { returning: () => p });
        },
      }),
    }),
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (where: unknown) => {
            sweepWheres.push(where);
            if (sweepThrows) throw new Error('db down');
            return { limit: async () => sweepRows };
          },
        }),
        where: () => ({}),
      }),
    }),
  },
}));

const mockReleaseAndNotify = mock(async (_taskId: string, _reason: string) => {});
const mockResolveReason = mock(async (_taskId: string) => 'merged' as const);
mock.module('@/lib/path-claim-release', () => ({
  releaseAndNotify: mockReleaseAndNotify,
  resolveReleaseReasonForTask: mockResolveReason,
}));
const mockTrigger = mock(async (..._a: unknown[]) => {});
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTrigger,
  channels: { workspace: (id: string) => `ws-${id}`, worker: (id: string) => `w-${id}` },
  events: { WORKER_COMPLETED: 'worker:completed', WORKER_FAILED: 'worker:failed' },
}));
const mockCapacityWake = mock(async (..._a: unknown[]) => {});
mock.module('@/lib/capacity-freed-wake', () => ({ wakeOldestPendingTaskOnCapacityFreed: mockCapacityWake }));
const mockWakeTask = mock(async (..._a: unknown[]) => {});
mock.module('@/lib/dispatch-authority', () => ({ wakeTask: mockWakeTask }));

const {
  detachInteractiveWorker,
  detachInteractiveWorkersOfEndedTasks,
  detachedWorkerOutcome,
  endedTaskInteractiveScope,
} = await import('./interactive-detach');
const { RELEASED_SLOT_WORKER_ERROR, isNonReactivatableError } = await import('./worker-termination');

const USER = { kind: 'user' as const, userId: 'u1', label: 'Sam' };

beforeEach(() => {
  workerRow = {
    id: 'w-leak', taskId: 't-done', accountId: 'acct-1', workspaceId: 'ws-1',
    status: 'running', runner: 'mcp',
  };
  taskRow = { id: 't-done', status: 'completed', prMerged: true };
  account = { id: 'acct-1', authType: 'oauth', activeSessions: 1 };
  sweepRows = [];
  workerWheres = [];
  sweepWheres = [];
  taskWrites = [];
  workerReadOverride = null;
  sweepThrows = false;
  for (const m of [mockReleaseAndNotify, mockResolveReason, mockTrigger, mockCapacityWake, mockWakeTask]) m.mockClear();
});

describe('completed task + live local session', () => {
  it('the sweep detaches it, so its seat is no longer counted', async () => {
    sweepRows = [{ id: 'w-leak', taskStatus: 'completed' }];
    const n = await detachInteractiveWorkersOfEndedTasks({ accountId: 'acct-1' });

    expect(n).toBe(1);
    expect(LIVE.has(workerRow!.status)).toBe(false);
    expect(account.activeSessions).toBe(0);
  });
});

describe('Release slot on a completed task with a merged PR', () => {
  it('marks the worker terminal, releases seat and path claims once, and leaves the task alone', async () => {
    const r = await detachInteractiveWorker({ workerId: 'w-leak', actor: USER, reason: 'task already ended' });

    expect(r).toMatchObject({ detached: true, workerStatus: 'completed', taskStatus: 'completed' });
    expect(workerRow).toMatchObject({ status: 'completed', exitCause: null, waitingFor: null });
    // Task: never written. Status and PR untouched.
    expect(taskWrites).toEqual([]);
    expect(taskRow).toEqual({ id: 't-done', status: 'completed', prMerged: true });
    // Seat and claims, exactly once.
    expect(account.activeSessions).toBe(0);
    expect(mockReleaseAndNotify).toHaveBeenCalledTimes(1);
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('t-done', 'merged');
    expect(mockCapacityWake).toHaveBeenCalledTimes(1);
  });

  it('a repeated release is a no-op', async () => {
    account.activeSessions = 2; // a second, unrelated live worker on the account
    await detachInteractiveWorker({ workerId: 'w-leak', actor: USER, reason: 'r' });
    const again = await detachInteractiveWorker({ workerId: 'w-leak', actor: USER, reason: 'r' });

    expect(again).toMatchObject({ detached: false, reason: 'already_released' });
    expect(account.activeSessions).toBe(1);
    expect(mockReleaseAndNotify).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });

  it('losing the compare-and-swap (a concurrent complete_task won) releases nothing', async () => {
    // The read sees it live; by the write the session's own completion landed.
    workerReadOverride = { ...workerRow };
    workerRow!.status = 'completed';
    const r = await detachInteractiveWorker({ workerId: 'w-leak', actor: USER, reason: 'r' });

    expect(r.detached).toBe(false);
    expect(account.activeSessions).toBe(1);
    expect(mockReleaseAndNotify).not.toHaveBeenCalled();
  });

  it('the worker write is guarded on the live statuses and the mcp runner', async () => {
    await detachInteractiveWorker({ workerId: 'w-leak', actor: USER, reason: 'r' });
    const q = dialect.sqlToQuery(workerWheres[0]);
    expect(q.sql).toContain('"workers"."runner" = $');
    expect(q.sql).toContain('"workers"."status" in (');
    expect(q.params).toContain('mcp');
    expect(q.params).toEqual(expect.arrayContaining(['idle', 'running', 'starting', 'waiting_input']));
  });
});

describe('scope of the primitive', () => {
  it('refuses a runner-backed worker: Stop agent keeps owning those', async () => {
    workerRow!.runner = 'runner-abc';
    const r = await detachInteractiveWorker({ workerId: 'w-leak', actor: USER, reason: 'r' });
    expect(r).toEqual({ detached: false, reason: 'not_interactive' });
    expect(workerRow!.status).toBe('running');
    expect(account.activeSessions).toBe(1);
  });

  it('an open task goes back to the queue; the detached worker cannot be revived', async () => {
    taskRow = { id: 't-done', status: 'assigned' };
    const r = await detachInteractiveWorker({ workerId: 'w-leak', actor: USER, reason: 'r' });

    expect(r.workerStatus).toBe('failed');
    expect(workerRow).toMatchObject({ exitCause: 'reassigned', error: RELEASED_SLOT_WORKER_ERROR });
    expect(isNonReactivatableError(workerRow!.error)).toBe(true);
    expect(taskRow).toMatchObject({ status: 'pending', claimedBy: null });
    expect(mockWakeTask).toHaveBeenCalledWith('t-done', 'task.requeued');
  });

  it('a cancelled task books the worker as bookkeeping, not a failure', () => {
    expect(detachedWorkerOutcome('cancelled')).toMatchObject({ status: 'failed', exitCause: 'task_cancelled' });
    expect(detachedWorkerOutcome('completed')).toEqual({ status: 'completed', exitCause: null, error: null });
  });
});

describe('the ended-task sweep scope', () => {
  const render = (opts: Parameters<typeof endedTaskInteractiveScope>[0]) => dialect.sqlToQuery(endedTaskInteractiveScope(opts));

  it('matches live mcp workers whose task is terminal, after the grace window', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    const q = render({ now, graceMs: 30_000 });
    expect(q.params).toEqual(expect.arrayContaining(['mcp', 'completed', 'failed', 'cancelled']));
    expect(q.sql).toContain('t_end.updated_at <');
    expect(q.params).toContain(new Date(now.getTime() - 30_000).toISOString());
  });

  it('the event door (one task, no grace) has no time window', () => {
    const q = render({ now: new Date(), graceMs: 0, taskId: 't-done' });
    expect(q.sql).not.toContain('updated_at');
    expect(q.params).toContain('t-done');
  });

  it('an account narrows to its team, as the never-started arm does', () => {
    const q = render({ now: new Date(), graceMs: 30_000, accountId: 'acct-1' });
    expect(q.sql).toContain('sibling.team_id');
    expect(q.params).toContain('acct-1');
  });

  it('never throws: a failing lookup reports 0', async () => {
    sweepThrows = true;
    const n = await detachInteractiveWorkersOfEndedTasks({ accountId: 'acct-1' });
    expect(n).toBe(0);
  });
});
