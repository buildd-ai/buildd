/**
 * B-6: a text-free `deliver_pending` command makes the runner collect the
 * queue now, instead of whenever the worker next happens to be dirty.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/pusher-deliver-pending.test.ts
 */

import { describe, test, expect, mock } from 'bun:test';
import { PusherManager } from '../../src/pusher-manager';

function makeManager() {
  const syncWorker = mock(async (_id: string) => {});
  const sendMessage = mock(async () => {});
  const callbacks = {
    getWorkers: () => new Map(),
    emit: mock(() => {}),
    emitCommand: mock(() => {}),
    abort: mock(async () => {}),
    sendMessage,
    syncWorker,
    rollback: mock(async () => ({})),
    recover: mock(async () => {}),
    sendHeartbeat: mock(() => {}),
    claimPendingTasks: mock(async () => []),
    claimAndStart: mock(async () => null),
    getProbedWorkers: () => new Set<string>(),
  };
  const manager = new PusherManager({ pusherChannelPrefix: '', acceptRemoteTasks: false } as any, {} as any, callbacks as any);
  return { manager, syncWorker, sendMessage };
}

describe('PusherManager deliver_pending', () => {
  test('triggers exactly one sync for that worker, and injects nothing itself', async () => {
    const { manager, syncWorker, sendMessage } = makeManager();
    await manager.handleCommand('w-1', { action: 'deliver_pending', timestamp: Date.now() });
    expect(syncWorker).toHaveBeenCalledTimes(1);
    expect(syncWorker.mock.calls[0][0]).toBe('w-1');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('legacy text message still injects directly', async () => {
    const { manager, syncWorker, sendMessage } = makeManager();
    await manager.handleCommand('w-1', { action: 'message', text: 'hi', timestamp: Date.now() });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(syncWorker).not.toHaveBeenCalled();
  });
});
