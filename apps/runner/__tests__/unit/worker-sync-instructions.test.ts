/**
 * Human-instruction delivery on the runner side.
 *
 * The sync loop is the only consumer of the server's instruction queue, but it
 * used to consume it anonymously: it dropped the boolean sendMessage returned
 * and never told the server anything, so the server marked instructions
 * delivered on hand-off (or, for urgent ones, at send time) and threw them away
 * whether or not they ever reached the agent.
 *
 * Guards here:
 *   - the sync payload declares itself a consumer, so other PATCH callers stop
 *     draining the queue;
 *   - delivery is confirmed only after a successful injection;
 *   - text that already reached the session (urgent message pushed over Pusher,
 *     then also served from the queue) is confirmed instead of replayed;
 *   - human text injected by another path is reported once.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-sync-instructions.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';

mock.module('../../src/worker-store', () => ({
  saveWorker: mock(() => {}),
  loadAllWorkers: mock(() => []),
}));

mock.module('../../src/git-operations', () => ({
  cleanupWorktree: mock(async () => {}),
}));

mock.module('../../src/session-logger', () => ({
  sessionLog: mock(() => {}),
}));

import { WorkerSync, type WorkerSyncContext } from '../../src/worker-sync';

const seenPayloads: any[] = [];
let responses: any[] = [];

const mockUpdateWorker = mock(async (_id: string, update: any) => {
  seenPayloads.push(update);
  return responses.shift() ?? {};
});

let sendMessageResult: boolean = true;
const sentMessages: Array<{ id: string; text: string }> = [];
const mockSendMessage = mock(async (id: string, text: string) => {
  sentMessages.push({ id, text });
  return sendMessageResult;
});

function makeWorker(overrides: Partial<any> = {}): any {
  return {
    id: 'w-instr',
    status: 'working',
    currentAction: 'Editing files',
    milestones: [],
    messages: [],
    subagentTasks: [],
    phaseText: '',
    phaseToolCount: 0,
    startedAt: Date.now() - 1000,
    lastActivity: Date.now(),
    ...overrides,
  };
}

function makeSync(worker: any) {
  const ctx: WorkerSyncContext = {
    config: { localUiUrl: 'http://localhost:8766' } as any,
    buildd: { updateWorker: mockUpdateWorker } as any,
    workers: new Map([[worker.id, worker]]),
    sessions: new Map(),
    dirtyWorkers: new Set<string>(),
    dirtyForDisk: new Set<string>(),
    emit: mock(() => {}),
    abort: mock(async () => {}) as any,
    sendMessage: mockSendMessage as any,
    getAdaptiveStaleTimeout: () => 300_000,
    setAdaptiveStaleTimeout: mock(() => {}),
    recentCycleTimes: [],
    probedWorkers: new Set<string>(),
    addMilestone: mock(() => {}),
    buildUserMessage: mock((content: string) => ({ content })),
  };
  return new WorkerSync(ctx);
}

/** Payloads that carry a delivery confirmation. */
function acks() {
  return seenPayloads.filter(p => typeof p.instructionsDelivered === 'string');
}

describe('WorkerSync instruction delivery', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    mockSendMessage.mockClear();
    seenPayloads.length = 0;
    sentMessages.length = 0;
    responses = [];
    sendMessageResult = true;
    mockSendMessage.mockImplementation(async (id: string, text: string) => {
      sentMessages.push({ id, text });
      return sendMessageResult;
    });
  });

  test('declares itself an instruction consumer', async () => {
    const worker = makeWorker();
    await makeSync(worker).syncWorkerToServer(worker);
    expect(seenPayloads[0].consumeInstructions).toBe(true);
  });

  test('injects served instructions and confirms delivery with the ack token', async () => {
    const worker = makeWorker();
    responses = [{ instructions: 'Use the device flow', instructionsAck: 'Use the device flow' }];

    await makeSync(worker).syncWorkerToServer(worker);

    expect(sentMessages).toEqual([{ id: 'w-instr', text: 'Use the device flow' }]);
    expect(acks()).toHaveLength(1);
    expect(acks()[0].instructionsDelivered).toBe('Use the device flow');
  });

  test('does not confirm delivery when the injection fails', async () => {
    const worker = makeWorker();
    responses = [{ instructions: 'Use the device flow', instructionsAck: 'Use the device flow' }];
    sendMessageResult = false;

    await makeSync(worker).syncWorkerToServer(worker);

    expect(sentMessages).toHaveLength(1);
    // Unconfirmed: the server keeps it queued and serves it again.
    expect(acks()).toHaveLength(0);
  });

  test('confirms without replaying text the session already received', async () => {
    // The urgent path pushes over Pusher AND queues as a fallback, so the same
    // text can be served after it was already injected.
    const worker = makeWorker({
      messages: [{ type: 'user', content: 'Stop and pivot', timestamp: Date.now() }],
    });
    responses = [{ instructions: 'Stop and pivot', instructionsAck: 'Stop and pivot' }];

    const sync = makeSync(worker);
    await sync.syncWorkerToServer(worker);

    expect(sentMessages).toHaveLength(0);
    expect(acks().map(a => a.instructionsDelivered)).toContain('Stop and pivot');
  });

  test('still injects appended mission notes when the instruction prefix is a duplicate', async () => {
    const worker = makeWorker({
      messages: [{ type: 'user', content: 'Stop and pivot', timestamp: Date.now() }],
    });
    responses = [{
      instructions: 'Stop and pivot\n\n**MISSION GUIDANCE:**\n- Prefer small PRs',
      instructionsAck: 'Stop and pivot',
    }];

    await makeSync(worker).syncWorkerToServer(worker);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('MISSION GUIDANCE');
    expect(sentMessages[0].text).not.toContain('Stop and pivot');
  });

  test('reports human text injected by another path exactly once', async () => {
    const worker = makeWorker();
    const sync = makeSync(worker);

    // First sync seeds the high-water mark without confirming history.
    await sync.syncWorkerToServer(worker);
    expect(acks()).toHaveLength(0);

    // A Pusher command injects a message outside this loop.
    worker.messages.push({ type: 'user', content: 'Stop and pivot', timestamp: Date.now() });
    await sync.syncWorkerToServer(worker);
    expect(acks().map(a => a.instructionsDelivered)).toEqual(['Stop and pivot']);

    // A later sync must not confirm it again.
    await sync.syncWorkerToServer(worker);
    expect(acks()).toHaveLength(1);
  });

  test('re-injects identical text sent again much later', async () => {
    // A human repeating themselves after 20 minutes means "you did not act on
    // this" — it must reach the agent, not be swallowed as a duplicate.
    const worker = makeWorker({
      messages: [{ type: 'user', content: 'Stop and pivot', timestamp: Date.now() - 20 * 60 * 1000 }],
    });
    responses = [{ instructions: 'Stop and pivot', instructionsAck: 'Stop and pivot' }];

    await makeSync(worker).syncWorkerToServer(worker);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe('Stop and pivot');
  });

  test('does not report its own injection as a foreign delivery', async () => {
    const worker = makeWorker();
    const sync = makeSync(worker);
    responses = [{ instructions: 'Use the device flow', instructionsAck: 'Use the device flow' }];
    // sendMessage in production appends the message to the transcript.
    mockSendMessage.mockImplementation(async (id: string, text: string) => {
      sentMessages.push({ id, text });
      worker.messages.push({ type: 'user', content: text, timestamp: Date.now() });
      return true;
    });

    await sync.syncWorkerToServer(worker);
    expect(acks()).toHaveLength(1);

    // Next cycle: nothing new to confirm.
    await sync.syncWorkerToServer(worker);
    expect(acks()).toHaveLength(1);
  });

  test('does not confirm agent output as human input', async () => {
    const worker = makeWorker();
    const sync = makeSync(worker);
    await sync.syncWorkerToServer(worker);

    worker.messages.push({ type: 'text', content: 'I will use the device flow', timestamp: Date.now() });
    await sync.syncWorkerToServer(worker);

    expect(acks()).toHaveLength(0);
  });
});
