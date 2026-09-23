/**
 * Regression tests for the two measurement-integrity defects in worker-store.
 *
 * Both live on the same module and one of them on the same line, so they share
 * a file:
 *
 *  1. The store root was resolved at module load, so no test could redirect it.
 *     `bun run test` therefore wrote fixture records into the operator's real
 *     worker store, where they were indistinguishable from fleet data: they read
 *     back as `error`-status workers (see 2), and the running runner logged a
 *     "not found remotely" reconcile line for each of them because their task
 *     ids have no server row. Any metric computed off that store was unfalsifiable.
 *
 *  2. The 24h TTL was measured from `_savedAt` — the *write* time — which
 *     `saveWorker` re-stamps on every persist and which the restart rewrite below
 *     also bumped. Every contact renewed the expiry, so records sat far past the
 *     nominal TTL without ever being reaped.
 *
 * This file does real filesystem I/O and must never mock 'fs'. It writes only
 * under its own BUILDD_HOME.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import type { LocalWorker } from '../../src/types';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'buildd-store-integrity-'));

// Set BEFORE the module under test is imported for the first time, so that a
// bare `bun test <this file>` (no runner injection) is also isolated. The
// `__resetWorkerStoreRoot` call in beforeAll is what proves the resolution is
// lazy rather than baked in at import.
process.env.BUILDD_HOME = TEST_HOME;

let store: typeof import('../../src/worker-store');

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** The real store. Read-only here: the whole point is that nothing touches it. */
const REAL_WORKERS_DIR = join(homedir(), '.buildd', 'workers');

function realStoreEntries(): string[] {
  try {
    return readdirSync(REAL_WORKERS_DIR).sort();
  } catch {
    return [];
  }
}

function workerFile(id: string): string {
  return join(TEST_HOME, 'workers', `${id}.json`);
}

let seq = 0;
function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  seq += 1;
  return {
    id: `integrity-w-${seq}`,
    taskId: `integrity-t-${seq}`,
    taskTitle: 'fixture worker',
    workspaceId: 'integrity-ws',
    workspaceName: 'fixture workspace',
    branch: 'fixture/branch',
    status: 'completed',
    startedAt: Date.now(),
    lastActivity: Date.now(),
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

/** Rewrite a persisted record's timestamps directly, as a stale file would look. */
function patchPersisted(id: string, patch: Record<string, unknown>): void {
  const path = workerFile(id);
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete data[key];
    else data[key] = value;
  }
  writeFileSync(path, JSON.stringify(data, null, 2));
}

beforeAll(async () => {
  store = await import('../../src/worker-store');
  // Forget anything memoised at import time and pick up TEST_HOME.
  store.__resetWorkerStoreRoot();
});

beforeEach(() => {
  // Each test starts from an empty store so a stray leftover cannot make an
  // expiry assertion pass for the wrong reason.
  rmSync(join(TEST_HOME, 'workers'), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('worker-store root is resolved lazily, not at module load', () => {
  test('saveWorker writes under BUILDD_HOME and not under the real home', () => {
    const before = realStoreEntries();

    const worker = makeWorker();
    store.saveWorker(worker);

    expect(existsSync(workerFile(worker.id))).toBe(true);
    // The assertion that actually mattered: the operator's store is untouched.
    expect(realStoreEntries()).toEqual(before);
  });

  test('loadWorker and loadAllWorkers read the same redirected root', () => {
    const worker = makeWorker();
    store.saveWorker(worker);

    expect(store.loadWorker(worker.id)?.id).toBe(worker.id);
    expect(store.loadAllWorkers().map(w => w.id)).toEqual([worker.id]);
  });

  test('__resetWorkerStoreRoot picks up a BUILDD_HOME set after first use', () => {
    const other = mkdtempSync(join(tmpdir(), 'buildd-store-integrity-alt-'));
    const previous = process.env.BUILDD_HOME;
    try {
      const worker = makeWorker();
      process.env.BUILDD_HOME = other;
      store.__resetWorkerStoreRoot();
      store.saveWorker(worker);

      expect(existsSync(join(other, 'workers', `${worker.id}.json`))).toBe(true);
      expect(existsSync(workerFile(worker.id))).toBe(false);
    } finally {
      process.env.BUILDD_HOME = previous;
      store.__resetWorkerStoreRoot();
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('the root is memoised, so the persist path does not re-read the env', () => {
    // Prod behaviour must stay byte-identical: resolve once, first use. A store
    // that re-read process.env on every call would follow this reassignment.
    const previous = process.env.BUILDD_HOME;
    try {
      // Warm the memo, then move the env underneath it.
      store.saveWorker(makeWorker());
      process.env.BUILDD_HOME = join(tmpdir(), 'buildd-store-integrity-never-used');

      const worker = makeWorker();
      store.saveWorker(worker);
      expect(existsSync(workerFile(worker.id))).toBe(true);
    } finally {
      process.env.BUILDD_HOME = previous;
      store.__resetWorkerStoreRoot();
    }
  });
});

describe('the 24h TTL is measured from activity, not from the last write', () => {
  test('loadWorker expires a record whose activity is stale even when _savedAt is fresh', () => {
    const worker = makeWorker({ status: 'completed' });
    store.saveWorker(worker);
    // Exactly the shape the batched dirty-flush produced: written moments ago,
    // inactive for over a day.
    patchPersisted(worker.id, {
      _savedAt: Date.now(),
      lastActivity: Date.now() - 25 * HOUR,
      completedAt: Date.now() - 25 * HOUR,
    });

    expect(store.loadWorker(worker.id)).toBeNull();
    expect(existsSync(workerFile(worker.id))).toBe(false);
  });

  test('loadAllWorkers expires a record whose activity is stale even when _savedAt is fresh', () => {
    const worker = makeWorker({ status: 'completed' });
    store.saveWorker(worker);
    patchPersisted(worker.id, {
      _savedAt: Date.now(),
      lastActivity: Date.now() - 25 * HOUR,
      completedAt: Date.now() - 25 * HOUR,
    });

    expect(store.loadAllWorkers()).toEqual([]);
    expect(existsSync(workerFile(worker.id))).toBe(false);
  });

  test('a recently-active record is retained even when _savedAt is old', () => {
    const worker = makeWorker({ status: 'working' });
    store.saveWorker(worker);
    patchPersisted(worker.id, {
      _savedAt: Date.now() - 25 * HOUR,
      lastActivity: Date.now(),
      completedAt: undefined,
    });

    expect(store.loadWorker(worker.id)?.id).toBe(worker.id);
    expect(existsSync(workerFile(worker.id))).toBe(true);
  });

  test('completedAt counts as activity when lastActivity is older', () => {
    const worker = makeWorker({ status: 'completed' });
    store.saveWorker(worker);
    patchPersisted(worker.id, {
      _savedAt: Date.now() - 25 * HOUR,
      lastActivity: Date.now() - 30 * HOUR,
      completedAt: Date.now() - 1 * HOUR,
    });

    expect(store.loadWorker(worker.id)?.id).toBe(worker.id);
  });

  test('a legacy record with no activity fields still expires off _savedAt', () => {
    const worker = makeWorker({ status: 'completed' });
    store.saveWorker(worker);
    patchPersisted(worker.id, {
      _savedAt: Date.now() - 25 * HOUR,
      lastActivity: undefined,
      completedAt: undefined,
    });

    expect(store.loadWorker(worker.id)).toBeNull();
    expect(existsSync(workerFile(worker.id))).toBe(false);
  });

  test('a legacy record with no activity fields and a fresh _savedAt is retained', () => {
    // Negative twin of the case above: the fallback must not expire everything.
    const worker = makeWorker({ status: 'completed' });
    store.saveWorker(worker);
    patchPersisted(worker.id, {
      _savedAt: Date.now(),
      lastActivity: undefined,
      completedAt: undefined,
    });

    expect(store.loadWorker(worker.id)?.id).toBe(worker.id);
  });

  test('the restart rewrite corrects the status without renewing the TTL', () => {
    const worker = makeWorker({ status: 'working' });
    store.saveWorker(worker);
    const stale = Date.now() - 12 * HOUR;
    patchPersisted(worker.id, { _savedAt: stale, lastActivity: stale, completedAt: undefined });

    const loaded = store.loadAllWorkers();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('error');
    expect(loaded[0].killedByRestart).toBe(true);

    // The bug: this rewrite used to stamp _savedAt = now, so every runner
    // restart pushed every in-flight worker's expiry out by another 24h.
    const persisted = JSON.parse(readFileSync(workerFile(worker.id), 'utf-8'));
    expect(persisted._savedAt).toBe(stale);
    expect(persisted.status).toBe('error');
    // A status correction is not activity.
    expect(persisted.lastActivity).toBe(stale);
  });

  test('a stale working record is expired rather than rewritten to error', () => {
    // Fixtures became immortal precisely because the rewrite ran first and then
    // renewed the clock. Expiry must win.
    const worker = makeWorker({ status: 'working' });
    store.saveWorker(worker);
    const ancient = Date.now() - (MAX_AGE_MS + HOUR);
    patchPersisted(worker.id, { _savedAt: ancient, lastActivity: ancient, completedAt: undefined });

    expect(store.loadAllWorkers()).toEqual([]);
    expect(existsSync(workerFile(worker.id))).toBe(false);
  });
});

describe('history-relevant fields survive persistence', () => {
  // history-store backfills from these files; without them a backfilled
  // session was archived with 0 tokens, no model and no PR URL.
  test('saveWorker persists resultMeta, prUrl and reportedModel', () => {
    const resultMeta = {
      stopReason: 'end_turn', durationMs: 1, durationApiMs: 1, numTurns: 1,
      modelUsage: {}, totalUsage: { inputTokens: 40, outputTokens: 7 },
    };
    const worker = makeWorker({
      resultMeta, prUrl: 'https://github.com/org/repo/pull/3', reportedModel: 'claude-opus-4-8',
    } as Partial<LocalWorker>);
    store.saveWorker(worker);

    const persisted = JSON.parse(readFileSync(workerFile(worker.id), 'utf-8'));
    expect(persisted.resultMeta).toEqual(resultMeta);
    expect(persisted.prUrl).toBe('https://github.com/org/repo/pull/3');
    expect(persisted.reportedModel).toBe('claude-opus-4-8');
  });
});
