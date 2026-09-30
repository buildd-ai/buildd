/**
 * `config.singleTask` (set by `buildd --once`): the WorkerManager must never
 * pull other work — every path into claimPendingTasks (heartbeat tick, Pusher
 * reconnect, budget-resume wake) becomes a no-op.
 */
import { describe, expect, mock, test } from 'bun:test';
import { WorkerManager } from '../../src/workers';

function manager(config: Record<string, unknown>) {
  const claimTask = mock(async () => ({ workers: [] }));
  const m = Object.create(WorkerManager.prototype) as any;
  Object.assign(m, {
    config,
    acceptRemoteTasks: true,
    workers: new Map(),
    buildd: { claimTask },
    emit: () => {},
  });
  return { m, claimTask };
}

describe('WorkerManager single-task mode', () => {
  test('claimPendingTasks never calls the claim endpoint', async () => {
    const { m, claimTask } = manager({ singleTask: true, maxConcurrent: 1 });
    expect(await m.claimPendingTasks()).toEqual([]);
    expect(claimTask).not.toHaveBeenCalled();
  });

  test('hasLiveSession reflects the session map', () => {
    const { m } = manager({ singleTask: true });
    m.sessions = new Map([['w-1', {}]]);
    expect(m.hasLiveSession('w-1')).toBe(true);
    expect(m.hasLiveSession('w-2')).toBe(false);
  });

  test('attachOutbox routes the manager client through the outbox', () => {
    const { m } = manager({ singleTask: true });
    const setOutbox = mock(() => {});
    m.buildd = { setOutbox };
    const outbox = {} as any;
    m.attachOutbox(outbox);
    expect(setOutbox).toHaveBeenCalledWith(outbox);
  });
});
