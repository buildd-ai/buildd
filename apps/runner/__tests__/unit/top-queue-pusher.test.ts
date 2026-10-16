/**
 * The runner tells `buildd top` when a task in one of its workspaces is
 * claimed, by it or by another runner (`task:claimed` on the workspace
 * channel), so the Queue view rereads its order within 2 s (spec c7410e76 AC-12).
 */
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PusherManager } from '../../src/pusher-manager';

function makeManager() {
  const emit = mock((_e: any) => {});
  const callbacks = {
    getWorkers: () => new Map(), emit, emitCommand: mock(() => {}), abort: mock(async () => {}), sendMessage: mock(async () => {}),
    syncWorker: mock(async () => {}), rollback: mock(async () => ({})), recover: mock(async () => {}), sendHeartbeat: mock(() => {}),
    claimPendingTasks: mock(async () => []), claimAndStart: mock(async () => null), getProbedWorkers: () => new Set<string>(),
  };
  return { manager: new PusherManager({ pusherChannelPrefix: '', acceptRemoteTasks: false } as any, {} as any, callbacks as any), emit };
}

describe('task:claimed reaches top as a queue change', () => {
  test('a claimed task becomes one task_claimed event', () => {
    const { manager, emit } = makeManager();
    manager.handleTaskClaimed({ task: { id: 't-1', workspaceId: 'ws-a' } });
    expect(emit.mock.calls).toEqual([[{ type: 'task_claimed', taskId: 't-1', workspaceId: 'ws-a' }]]);
  });

  test('a frame without a task id is dropped', () => {
    const { manager, emit } = makeManager();
    manager.handleTaskClaimed({});
    manager.handleTaskClaimed(null);
    expect(emit).not.toHaveBeenCalled();
  });

  test('the workspace channel binds task:claimed, and unbinds it with task:assigned', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/pusher-manager.ts'), 'utf8');
    expect(src).toContain("channel.bind('task:claimed'");
    expect(src).toContain("channel.unbind('task:claimed')");
  });
});
