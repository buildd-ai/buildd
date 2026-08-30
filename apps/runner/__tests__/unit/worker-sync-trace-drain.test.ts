/**
 * Regression guard: pendingErrorTraces / pendingMcpCalls must be drained BEFORE
 * the sync PATCH is awaited, not after.
 *
 * The buffers used to be read into the payload and only cleared once the await
 * resolved, so two overlapping syncs both shipped the same entries and every
 * buffered stderr trace / MCP call was filed twice server-side. Durable stderr
 * capture stages a trace as soon as stderr arrives (so a hung session still
 * reports), which made the duplication routine rather than rare.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-sync-trace-drain.test.ts
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

let resolveUpdate: ((value: any) => void) | null = null;
let updateBehaviour: 'ok' | 'gate' | 'throw' = 'ok';
const seenPayloads: any[] = [];

const mockUpdateWorker = mock(async (_id: string, update: any) => {
  seenPayloads.push(update);
  if (updateBehaviour === 'throw') throw new Error('network down');
  if (updateBehaviour === 'gate') {
    return new Promise(resolve => { resolveUpdate = resolve; });
  }
  return {};
});

function makeWorker(overrides: Partial<any> = {}): any {
  return {
    id: 'w-drain',
    status: 'working',
    currentAction: 'Editing files',
    milestones: [],
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

const TRACE = { pattern: 'cli_stderr', excerpt: 'bwrap: No permitted namespaces', source: 'stderr' };

describe('WorkerSync append-buffer drain', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    seenPayloads.length = 0;
    updateBehaviour = 'ok';
    resolveUpdate = null;
  });

  test('ships buffered error traces once and clears the buffer', async () => {
    const worker = makeWorker({ pendingErrorTraces: [{ ...TRACE }] });
    await makeSync(worker).syncWorkerToServer(worker);

    expect(seenPayloads).toHaveLength(1);
    expect(seenPayloads[0].appendErrorTraces).toHaveLength(1);
    expect(worker.pendingErrorTraces).toHaveLength(0);
  });

  test('two overlapping syncs do not file the same trace twice', async () => {
    const worker = makeWorker({ pendingErrorTraces: [{ ...TRACE }] });
    const sync = makeSync(worker);

    updateBehaviour = 'gate';
    const first = sync.syncWorkerToServer(worker);
    // Second sync starts while the first PATCH is still in flight.
    updateBehaviour = 'ok';
    await sync.syncWorkerToServer(worker);
    resolveUpdate?.({});
    await first;

    const shipped = seenPayloads.flatMap(p => p.appendErrorTraces ?? []);
    expect(shipped).toHaveLength(1);
  });

  test('drains MCP calls the same way', async () => {
    const worker = makeWorker({
      pendingMcpCalls: [{ server: 'buildd', tool: 'get_task', ts: 1, ok: true }],
    });
    const sync = makeSync(worker);

    updateBehaviour = 'gate';
    const first = sync.syncWorkerToServer(worker);
    updateBehaviour = 'ok';
    await sync.syncWorkerToServer(worker);
    resolveUpdate?.({});
    await first;

    const shipped = seenPayloads.flatMap(p => p.appendMcpCalls ?? []);
    expect(shipped).toHaveLength(1);
  });

  test('restores drained traces when the sync PATCH throws', async () => {
    const worker = makeWorker({ pendingErrorTraces: [{ ...TRACE }] });
    updateBehaviour = 'throw';
    await makeSync(worker).syncWorkerToServer(worker).catch(() => {});
    expect(worker.pendingErrorTraces).toHaveLength(1);
    expect(worker.pendingErrorTraces[0].excerpt).toBe(TRACE.excerpt);
  });

  test('omits the append keys entirely when nothing is buffered', async () => {
    const worker = makeWorker();
    await makeSync(worker).syncWorkerToServer(worker);
    expect(seenPayloads[0].appendErrorTraces).toBeUndefined();
    expect(seenPayloads[0].appendMcpCalls).toBeUndefined();
  });
});
