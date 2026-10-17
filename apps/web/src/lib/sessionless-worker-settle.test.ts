/**
 * Settling a live worker with no session: a question park on a cancelled or
 * deleted task. Seen in production: a run asked a question, nobody answered,
 * the task was cancelled and deleted, and the worker row stayed
 * `waiting_input` for a day, holding an account slot and drawn on Health as a
 * 23h run that "Has a question".
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/sessionless-worker-settle.test.ts
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

let setArg: any = null;
let whereArg: any = null;
let returned: any[] = [];
const mockUpdate = mock(() => ({
  set: (v: any) => {
    setArg = v;
    return {
      where: (w: any) => {
        whereArg = w;
        return { returning: () => Promise.resolve(returned) };
      },
    };
  },
}));
mock.module('@buildd/core/db', () => ({ db: { update: mockUpdate } }));

const mockTriggerEvent = mock((..._a: any[]) => Promise.resolve());
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { WORKER_FAILED: 'worker:failed' },
}));
const mockReleaseSeats = mock((_ids: any[]) => Promise.resolve());
mock.module('@/lib/interactive-detach', () => ({ releaseConcurrencySeats: mockReleaseSeats }));
const mockWake = mock((_ws: string, _ex: string | null) => Promise.resolve());
mock.module('@/lib/capacity-freed-wake', () => ({ wakeOldestPendingTaskOnCapacityFreed: mockWake }));

import { runEndReason } from './fleet-view-end-reason';
import { sessionlessLiveWorkerSql, settleOrphanedSessionlessWorkers, settleSessionlessWorkersOfTask } from './sessionless-worker-settle';

const render = (s: any) => new PgDialect().sqlToQuery(s);

describe('settleSessionlessWorkersOfTask', () => {
  beforeEach(() => {
    setArg = null;
    whereArg = null;
    returned = [];
    mockTriggerEvent.mockClear();
    mockReleaseSeats.mockClear();
    mockWake.mockClear();
  });

  it('moves the worker out of the live set, closes its question and keeps the row', async () => {
    returned = [{ id: 'w1', taskId: 't1', accountId: 'a1', workspaceId: 'ws1' }];
    expect(await settleSessionlessWorkersOfTask('t1', 'task_cancelled')).toBe(1);
    expect(setArg).toMatchObject({ status: 'failed', exitCause: 'task_cancelled', waitingFor: null });
    expect(setArg.completedAt).toBeInstanceOf(Date);
    expect(setArg.error).toContain('cancelled');
  });

  it('releases the seat, tells dashboards and wakes the queue once per row it moved', async () => {
    returned = [{ id: 'w1', taskId: 't1', accountId: 'a1', workspaceId: 'ws1' }];
    await settleSessionlessWorkersOfTask('t1', 'task_deleted');
    expect(mockReleaseSeats).toHaveBeenCalledWith(['a1']);
    expect(mockTriggerEvent).toHaveBeenCalledWith('workspace-ws1', 'worker:failed', expect.objectContaining({ workerId: 'w1', status: 'failed' }));
    expect(mockWake).toHaveBeenCalledTimes(1);
  });

  it('a repeat that moves nothing releases nothing (exactly once)', async () => {
    returned = [];
    expect(await settleSessionlessWorkersOfTask('t1', 'task_cancelled')).toBe(0);
    expect(mockReleaseSeats).not.toHaveBeenCalled();
    expect(mockTriggerEvent).not.toHaveBeenCalled();
    expect(mockWake).not.toHaveBeenCalled();
  });

  it('only matches live rows with no session: question park, pause, parked run', () => {
    const { sql, params } = render(sessionlessLiveWorkerSql());
    expect(sql).toContain('"parked_until" is not null');
    expect(sql).toContain('LIKE');
    expect(params).toContain('needs_input%');
    expect(sql).toContain(`->>'type' = 'pause'`);
    // A running worker or a question inside a live session is aborted, not settled.
    expect(params).toEqual(expect.arrayContaining(['idle', 'running', 'starting', 'waiting_input']));
  });

  it('scopes to the task', async () => {
    await settleSessionlessWorkersOfTask('t1', 'task_cancelled');
    const { params } = render(whereArg);
    expect(params).toContain('t1');
  });
});

describe('settleOrphanedSessionlessWorkers', () => {
  beforeEach(() => {
    whereArg = null;
    returned = [];
  });

  it('repairs rows whose task is deleted or terminal, never an interactive session', async () => {
    returned = [{ id: 'w-old', taskId: null, accountId: 'a1', workspaceId: 'ws1' }];
    expect(await settleOrphanedSessionlessWorkers('a1')).toBe(1);
    const { sql, params } = render(whereArg);
    expect(sql).toContain('"task_id" IS NULL');
    expect(params).toEqual(expect.arrayContaining(['completed', 'failed', 'cancelled', 'mcp', 'a1']));
  });
});

describe('how a settled run reads on Health', () => {
  it('says the run was cancelled while waiting, never that it has a question or failed', async () => {
    for (const [cause, words] of [
      ['task_cancelled', 'Cancelled while waiting for an answer'],
      ['task_deleted', 'Cancelled while waiting for an answer'],
    ] as const) {
      returned = [];
      await settleSessionlessWorkersOfTask('t1', cause);
      expect(runEndReason({ status: setArg.status, error: setArg.error, waitingFor: setArg.waitingFor })).toBe(words);
    }
    await settleOrphanedSessionlessWorkers();
    expect(runEndReason({ status: setArg.status, error: setArg.error })).toBe('Question closed: the task had ended');
  });
});
