/**
 * A quiet working worker's sync carries liveness, not its whole view (spec
 * 3ef37387 R-33): once the server has acknowledged a report, the next one
 * leaves out the milestone list, current action and local UI URL when they
 * have not changed, so the server compares nothing and writes nothing. The
 * full report goes again on any change, after a report that may not have
 * landed, for a waiting worker, and at least every FULL_REPORT_INTERVAL_MS.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-sync-lean-quiet.test.ts
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

mock.module('child_process', () => ({ execSync: mock(() => '') }));
mock.module('fs', () => ({ existsSync: mock(() => false) }));

import { WorkerSync, FULL_REPORT_INTERVAL_MS, type WorkerSyncContext } from '../../src/worker-sync';

const seenPayloads: any[] = [];
// A landed PATCH answers a body; the outbox's queued placeholder is `{}`.
let reply: any = { ok: true };
const mockUpdateWorker = mock(async (_id: string, update: any) => {
  seenPayloads.push(update);
  if (reply instanceof Error) throw reply;
  return reply;
});

function makeWorker(overrides: Partial<any> = {}): any {
  return {
    id: 'w-lean',
    status: 'working',
    currentAction: 'Editing files',
    milestones: [],
    subagentTasks: [],
    phaseText: '',
    phaseToolCount: 0,
    startedAt: Date.now() - 1000,
    lastActivity: Date.now(),
    branch: 'buildd/abc12345-some-task',
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
    sendMessage: mock(async () => {}) as any,
    getAdaptiveStaleTimeout: () => 300_000,
    setAdaptiveStaleTimeout: mock(() => {}),
    recentCycleTimes: [],
    probedWorkers: new Set<string>(),
    addMilestone: mock(() => {}),
    buildUserMessage: mock((content: string) => ({ content })),
  };
  return new WorkerSync(ctx);
}

const realNow = Date.now;
const HEAVY = ['milestones', 'currentAction', 'localUiUrl'] as const;
const has = (p: any, k: string) => Object.prototype.hasOwnProperty.call(p, k);

describe('WorkerSync quiet report', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    seenPayloads.length = 0;
    reply = { ok: true };
    Date.now = realNow;
  });

  test('a second unchanged report sends liveness only: status, branch and the instruction consumer', async () => {
    const worker = makeWorker({ milestones: [{ type: 'action', label: 'Read a.ts', ts: 1 }] });
    const sync = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    await sync.syncWorkerToServer(worker);
    for (const k of HEAVY) expect(has(seenPayloads[0], k)).toBe(true);
    for (const k of HEAVY) expect(has(seenPayloads[1], k)).toBe(false);
    expect(seenPayloads[1].status).toBe('running');
    expect(seenPayloads[1].branch).toBe(worker.branch);
    expect(seenPayloads[1].consumeInstructions).toBe(true);
    expect(JSON.stringify(seenPayloads[1]).length).toBeLessThan(JSON.stringify(seenPayloads[0]).length);
  });

  test('a field that changed goes again; the unchanged ones stay out', async () => {
    const worker = makeWorker();
    const sync = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    worker.milestones.push({ type: 'action', label: 'Edit b.ts', ts: 2 });
    await sync.syncWorkerToServer(worker);
    expect(seenPayloads[1].milestones).toHaveLength(1);
    expect(has(seenPayloads[1], 'currentAction')).toBe(false);
  });

  test('a report that may not have landed (the outbox placeholder) is followed by the full report', async () => {
    const worker = makeWorker();
    const sync = makeSync(worker);
    reply = {};
    await sync.syncWorkerToServer(worker);
    reply = { ok: true };
    await sync.syncWorkerToServer(worker);
    for (const k of HEAVY) expect(has(seenPayloads[1], k)).toBe(true);
  });

  test('a failed report is followed by the full report', async () => {
    const worker = makeWorker();
    const sync = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    reply = new TypeError('fetch failed');
    await sync.syncWorkerToServer(worker).catch(() => {});
    reply = { ok: true };
    await sync.syncWorkerToServer(worker);
    for (const k of HEAVY) expect(has(seenPayloads[2], k)).toBe(true);
  });

  test('the full report goes at least every FULL_REPORT_INTERVAL_MS', async () => {
    let now = 5_000_000;
    Date.now = () => now;
    const worker = makeWorker();
    const sync = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    now += FULL_REPORT_INTERVAL_MS - 1;
    await sync.syncWorkerToServer(worker);
    now += 2;
    await sync.syncWorkerToServer(worker);
    expect(has(seenPayloads[1], 'milestones')).toBe(false);
    for (const k of HEAVY) expect(has(seenPayloads[2], k)).toBe(true);
  });

  test('a waiting worker always sends its whole report', async () => {
    const worker = makeWorker({ status: 'waiting', waitingFor: { type: 'question', prompt: 'Which one?' } });
    const sync = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    await sync.syncWorkerToServer(worker);
    for (const k of HEAVY) expect(has(seenPayloads[1], k)).toBe(true);
  });

  test('a worker coming back from waiting sends its whole report', async () => {
    const worker = makeWorker({ status: 'waiting', waitingFor: { type: 'question', prompt: 'Which one?' } });
    const sync = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    worker.status = 'working';
    worker.waitingFor = undefined;
    await sync.syncWorkerToServer(worker);
    for (const k of HEAVY) expect(has(seenPayloads[1], k)).toBe(true);
  });
});
