/**
 * Task b8af9282: a held runner runs an assignment only when the server says a
 * person aimed it here (`byPerson: true`), never because it carries a
 * targetLocalUiUrl. An agent's API key used to be able to start work on a held
 * runner just by naming it (spec c7410e76 R-34).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/pusher-assignment-by-person.test.ts
 */

import { describe, test, expect, mock } from 'bun:test';
import { PusherManager } from '../../src/pusher-manager';

const URL = 'http://localhost:8766';

function makeManager() {
  const claimAndStart = mock(async (_task: unknown, _opts?: { byPerson?: boolean }) => null);
  const callbacks = {
    getWorkers: () => new Map(),
    emit: mock(() => {}),
    emitCommand: mock(() => {}),
    abort: mock(async () => {}),
    sendMessage: mock(async () => {}),
    syncWorker: mock(async () => {}),
    rollback: mock(async () => ({})),
    recover: mock(async () => {}),
    sendHeartbeat: mock(() => {}),
    claimPendingTasks: mock(async () => []),
    claimAndStart,
    getProbedWorkers: () => new Set<string>(),
  };
  const manager = new PusherManager(
    { pusherChannelPrefix: '', acceptRemoteTasks: true, localUiUrl: URL, maxConcurrent: 3 } as any,
    {} as any,
    callbacks as any,
  );
  return { manager, claimAndStart };
}

const task = { id: 't-1', title: 'T', workspaceId: 'ws-1' } as any;

describe('PusherManager task:assigned person flag', () => {
  test('aimed here by a person: passes a hold', async () => {
    const { manager, claimAndStart } = makeManager();
    await manager.handleTaskAssignment({ task, targetLocalUiUrl: URL, byPerson: true });
    expect(claimAndStart.mock.calls[0][1]).toEqual({ byPerson: true });
  });

  test('aimed here without the person flag (an older server, or a key): held like a broadcast', async () => {
    const { manager, claimAndStart } = makeManager();
    await manager.handleTaskAssignment({ task, targetLocalUiUrl: URL });
    expect(claimAndStart.mock.calls[0][1]).toEqual({ byPerson: false });
  });

  test('a broadcast never counts as a person, whatever the flag says', async () => {
    const { manager, claimAndStart } = makeManager();
    await manager.handleTaskAssignment({ task, targetLocalUiUrl: null, byPerson: true });
    expect(claimAndStart.mock.calls[0][1]).toEqual({ byPerson: false });
  });

  test('aimed at another runner: ignored', async () => {
    const { manager, claimAndStart } = makeManager();
    await manager.handleTaskAssignment({ task, targetLocalUiUrl: 'http://elsewhere:8766', byPerson: true });
    expect(claimAndStart).not.toHaveBeenCalled();
  });
});
