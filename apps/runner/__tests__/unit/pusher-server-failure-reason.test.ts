/**
 * Task 915e19eb (R-22): when the server marks a worker failed, the runner keeps
 * the reason the worker recorded instead of writing "Task failed on server".
 * The server's thin event carries no error, so the runner reads the worker row.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/pusher-server-failure-reason.test.ts
 */
import { describe, expect, mock, test } from 'bun:test';
import { PusherManager } from '../../src/pusher-manager';

function setup(remote: unknown, local: Record<string, unknown> = {}) {
  const worker: any = { id: 'w-1', status: 'working', ...local };
  const workers = new Map([['w-1', worker]]);
  const emit = mock((_e: any) => {});
  const callbacks = {
    getWorkers: () => workers,
    emit,
    emitCommand: mock(() => {}),
    abort: mock(async () => {}),
    sendMessage: mock(async () => {}),
    rollback: mock(async () => ({})),
    recover: mock(async () => {}),
    sendHeartbeat: mock(() => {}),
    claimPendingTasks: mock(async () => []),
    claimAndStart: mock(async () => null),
    getProbedWorkers: () => new Set<string>(),
  };
  const buildd = { getWorkerRemote: mock(async () => remote) };
  const manager = new PusherManager({ pusherChannelPrefix: '', acceptRemoteTasks: false } as any, buildd as any, callbacks as any);
  return { manager, worker, emit, buildd };
}

describe('server-marked failure keeps a real reason', () => {
  test('the event carries an error: it is used as is', async () => {
    const { manager, worker, buildd } = setup(null);
    await manager.applyServerFailure('w-1', { error: 'Agent exceeded max turns' });
    expect(worker.status).toBe('error');
    expect(worker.error).toBe('Agent exceeded max turns');
    expect(buildd.getWorkerRemote).not.toHaveBeenCalled();
  });

  test('a thin event: the reason comes from the worker row', async () => {
    const { manager, worker, emit } = setup({ status: 'failed', error: 'git push rejected (non-fast-forward)' });
    await manager.applyServerFailure('w-1', { status: 'failed' });
    expect(worker.error).toBe('git push rejected (non-fast-forward)');
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'worker_update', worker: { error: 'git push rejected (non-fast-forward)' } });
  });

  test('a reason the worker already had locally is kept', async () => {
    const { manager, worker } = setup({ status: 'failed', error: null }, { error: 'bun test exited 1' });
    await manager.applyServerFailure('w-1', {});
    expect(worker.error).toBe('bun test exited 1');
  });

  test('nothing recorded anywhere: the generic line, and the row lookup failing is harmless', async () => {
    const { manager, worker, buildd } = setup(null);
    buildd.getWorkerRemote.mockImplementation(async () => { throw new Error('offline'); });
    await manager.applyServerFailure('w-1', {});
    expect(worker.status).toBe('error');
    expect(worker.error).toBe('Task failed on server');
  });
});
