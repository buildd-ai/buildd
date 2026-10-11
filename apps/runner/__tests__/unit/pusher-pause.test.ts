/**
 * Task baf3809a: a `pause` command reaches WorkerManager.pauseWorker (it used
 * to be a logged TODO), and never aborts the worker.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/pusher-pause.test.ts
 */

import { describe, test, expect, mock } from 'bun:test';
import { PusherManager } from '../../src/pusher-manager';

function makeManager(withPause = true) {
  const pause = mock(async (_id: string) => 'apply');
  const abort = mock(async () => {});
  const callbacks = {
    getWorkers: () => new Map(),
    emit: mock(() => {}),
    emitCommand: mock(() => {}),
    abort,
    ...(withPause ? { pause } : {}),
    sendMessage: mock(async () => {}),
    syncWorker: mock(async () => {}),
    rollback: mock(async () => ({})),
    recover: mock(async () => {}),
    sendHeartbeat: mock(() => {}),
    claimPendingTasks: mock(async () => []),
    claimAndStart: mock(async () => null),
    getProbedWorkers: () => new Set<string>(),
  };
  const manager = new PusherManager({ pusherChannelPrefix: '', acceptRemoteTasks: false } as any, {} as any, callbacks as any);
  return { manager, pause, abort };
}

describe('PusherManager pause', () => {
  test('pauses that worker and does not abort it', async () => {
    const { manager, pause, abort } = makeManager();
    await manager.handleCommand('w-1', { action: 'pause', timestamp: Date.now() });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(pause.mock.calls[0][0]).toBe('w-1');
    expect(abort).not.toHaveBeenCalled();
  });

  test('an embedder without pause support ignores it', async () => {
    const { manager, abort } = makeManager(false);
    await manager.handleCommand('w-1', { action: 'pause', timestamp: Date.now() });
    expect(abort).not.toHaveBeenCalled();
  });
});
