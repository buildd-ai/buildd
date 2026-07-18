/**
 * PusherManager abort guard — verifies that a push abort arriving after
 * complete_task (i.e. when the worker is already in a terminal state) is
 * silently ignored instead of flipping the worker back to 'error'.
 *
 * Run: bun test apps/runner/__tests__/unit/pusher-abort-guard.test.ts
 */

import { describe, test, expect, mock } from 'bun:test';
import { PusherManager } from '../../src/pusher-manager';
import type { LocalWorker } from '../../src/types';

function makeWorker(status: LocalWorker['status']): LocalWorker {
  return {
    id: 'w-1',
    taskId: 't-1',
    taskTitle: 'Test',
    taskDescription: '',
    taskMode: undefined,
    taskBackend: 'claude',
    workspaceId: 'ws-1',
    workspaceName: 'test',
    branch: 'buildd/test',
    status,
    hasNewActivity: false,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    milestones: [],
    currentAction: '',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    checkpoints: [],
    subagentTasks: [],
    checkpointEvents: new Set(),
    pendingMcpCalls: [],
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
  };
}

function makePusherManager(workers: Map<string, LocalWorker>) {
  const abortFn = mock(async () => {});
  const callbacks = {
    getWorkers: () => workers,
    emit: mock(() => {}),
    emitCommand: mock(() => {}),
    abort: abortFn,
    sendMessage: mock(async () => {}),
    rollback: mock(async () => ({})),
    recover: mock(async () => {}),
    sendHeartbeat: mock(() => {}),
    claimPendingTasks: mock(async () => []),
    claimAndStart: mock(async () => null),
    getProbedWorkers: () => new Set<string>(),
  };

  const config: any = {
    pusherKey: undefined,
    pusherCluster: undefined,
    pusherChannelPrefix: '',
    acceptRemoteTasks: false,
    maxConcurrent: 2,
    localUiUrl: undefined,
    builddServer: 'http://localhost',
    apiKey: 'test-key',
  };

  const manager = new PusherManager(config, {} as any, callbacks);
  return { manager, abortFn };
}

describe('PusherManager abort guard', () => {
  test('calls abort when worker is active (working)', async () => {
    const workers = new Map<string, LocalWorker>();
    workers.set('w-1', makeWorker('working'));
    const { manager, abortFn } = makePusherManager(workers);

    await manager.handleCommand('w-1', { action: 'abort' });

    expect(abortFn).toHaveBeenCalledTimes(1);
  });

  test('skips abort when worker is already done', async () => {
    const workers = new Map<string, LocalWorker>();
    workers.set('w-1', makeWorker('done'));
    const { manager, abortFn } = makePusherManager(workers);

    await manager.handleCommand('w-1', { action: 'abort' });

    expect(abortFn).not.toHaveBeenCalled();
  });

  test('skips abort when worker is already in error state', async () => {
    const workers = new Map<string, LocalWorker>();
    workers.set('w-1', makeWorker('error'));
    const { manager, abortFn } = makePusherManager(workers);

    await manager.handleCommand('w-1', { action: 'abort' });

    expect(abortFn).not.toHaveBeenCalled();
  });

  test('calls abort when worker not in map (no local state)', async () => {
    const workers = new Map<string, LocalWorker>();
    // worker 'w-1' not added — unknown state, abort proceeds so server can reconcile
    const { manager, abortFn } = makePusherManager(workers);

    await manager.handleCommand('w-1', { action: 'abort' });

    expect(abortFn).toHaveBeenCalledTimes(1);
  });
});
