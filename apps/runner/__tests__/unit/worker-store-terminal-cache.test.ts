/**
 * loadTerminalWorkersCached — bounds the disk read `getWorkers()` pays on
 * every call.
 *
 * `getWorkers()` merges in-memory workers with the done/error workers still
 * on disk (24h history) by calling `loadAllWorkers()` — a full `readdirSync`
 * + JSON.parse of every file in the store — on EVERY call, and it's on
 * several hot paths: GET /health, GET /api/workers, the GET /api/events SSE
 * init payload, a 60s watchdog, and the periodic reconcile pass. A 23-day
 * audit of the live runner found the store routinely reaches several hundred
 * files, so this was the actual bottleneck on hot paths, not disk I/O in the
 * abstract.
 *
 * This file does real filesystem I/O and must never mock 'fs' (see
 * worker-store-integrity.test.ts for why: the store root itself is
 * lazily-resolved and a broad fs mock would hide a real regression there).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-store-terminal-cache.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LocalWorker } from '../../src/types';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'buildd-store-terminal-cache-'));
process.env.BUILDD_HOME = TEST_HOME;

let store: typeof import('../../src/worker-store');

let seq = 0;
function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  seq += 1;
  return {
    id: `cache-w-${seq}`,
    taskId: `cache-t-${seq}`,
    taskTitle: 'fixture worker',
    workspaceId: 'cache-ws',
    workspaceName: 'fixture workspace',
    branch: 'fixture/branch',
    status: 'done',
    startedAt: Date.now(),
    lastActivity: Date.now(),
    completedAt: Date.now(),
    messages: [],
    milestones: [],
    toolCalls: [],
    commits: [],
    output: [],
    hasNewActivity: false,
    currentAction: '',
    subagentTasks: [],
    checkpoints: [],
    checkpointEvents: new Set(),
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
    ...overrides,
  } as unknown as LocalWorker;
}

beforeAll(async () => {
  store = await import('../../src/worker-store');
  store.__resetWorkerStoreRoot();
});

beforeEach(() => {
  rmSync(join(TEST_HOME, 'workers'), { recursive: true, force: true });
  store.__resetDiskWorkersCache();
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('loadTerminalWorkersCached', () => {
  test('repeated calls within the TTL window scan the disk exactly once', () => {
    store.saveWorker(makeWorker());
    store.saveWorker(makeWorker());

    const base = Date.now();
    const first = store.loadTerminalWorkersCached(base);
    for (let i = 0; i < 50; i++) {
      store.loadTerminalWorkersCached(base + i);
    }

    expect(first.length).toBe(2);
    expect(store.__getDiskScanCountForTests()).toBe(1);
  });

  test('a call after the TTL elapses re-scans and picks up new files', () => {
    store.saveWorker(makeWorker());
    const base = Date.now();
    const before = store.loadTerminalWorkersCached(base);
    expect(before.length).toBe(1);

    // A worker finishing and getting written to disk mid-window must not be
    // visible until the cache actually refreshes.
    store.saveWorker(makeWorker());
    const stillCached = store.loadTerminalWorkersCached(base + 1000);
    expect(stillCached.length).toBe(1);
    expect(store.__getDiskScanCountForTests()).toBe(1);

    const refreshed = store.loadTerminalWorkersCached(base + 10_000);
    expect(refreshed.length).toBe(2);
    expect(store.__getDiskScanCountForTests()).toBe(2);
  });

  test('only done/error workers are returned — a live worker on disk is excluded', () => {
    store.saveWorker(makeWorker({ status: 'done' }));
    store.saveWorker(makeWorker({ status: 'error', completedAt: Date.now() }));
    // 'waiting' is a live, resumable worker — 'working' would be rewritten to
    // 'error' by loadAllWorkers itself (a zombie at load time), so it can't
    // stand in for "not yet terminal" here.
    store.saveWorker(makeWorker({ status: 'waiting', completedAt: undefined }));

    const result = store.loadTerminalWorkersCached(Date.now());
    expect(result.map(w => w.status).sort()).toEqual(['done', 'error']);
  });

  test('__resetDiskWorkersCache forces an immediate re-scan', () => {
    store.saveWorker(makeWorker());
    store.loadTerminalWorkersCached(Date.now());
    store.loadTerminalWorkersCached(Date.now());
    expect(store.__getDiskScanCountForTests()).toBe(1);

    // Reset clears the cache (and its own counter) — the very next call must
    // scan again rather than serving the pre-reset snapshot.
    store.__resetDiskWorkersCache();
    store.loadTerminalWorkersCached(Date.now());
    expect(store.__getDiskScanCountForTests()).toBe(1);
  });
});
