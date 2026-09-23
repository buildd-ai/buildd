/**
 * Every runner store reads back what it wrote, under a temp BUILDD_HOME.
 *
 * `buildd-home-guard.test.ts` proves the stores refuse the real home. That
 * only exercises write paths, and moving the path constants to lazy
 * resolution once left `readClaimLogs` pointing at a deleted module constant:
 * it threw a ReferenceError on every call, which took down the runner's claim
 * diagnostics endpoint while every write-side test stayed green. This pins the
 * read side of each store, against the real module and not a mock.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-home-read-paths.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A home of our own, under the OS temp dir so the guard accepts it. Set
// before any store resolves a path (they resolve lazily, at first use).
const injectedHome = process.env.BUILDD_HOME;
const home = mkdtempSync(join(tmpdir(), 'buildd-home-read-paths-'));
process.env.BUILDD_HOME = home;

const { sessionLog, readSessionLogs, claimLog, readClaimLogs } = await import('../../src/session-logger');
const { saveWorker, loadWorker, __resetWorkerStoreRoot } = await import('../../src/worker-store');
const { initHistory, archiveSession, getArchivedData, getSession, closeHistory } = await import('../../src/history-store');
const { Outbox } = await import('../../src/outbox');

beforeAll(() => __resetWorkerStoreRoot());
afterAll(() => {
  try { closeHistory(); } catch {}
  rmSync(home, { recursive: true, force: true });
  if (injectedHome === undefined) delete process.env.BUILDD_HOME;
  else process.env.BUILDD_HOME = injectedHome;
});

function worker(id: string) {
  return {
    id,
    taskId: `${id}-task`,
    taskTitle: 'read-path probe',
    workspaceId: 'ws-probe',
    workspaceName: 'probe',
    status: 'done',
    lastActivity: Date.now(),
    milestones: [],
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
  } as any;
}

describe('session-logger reads', () => {
  test('readClaimLogs returns what claimLog wrote', () => {
    claimLog({ event: 'claim_empty', slotsRequested: 2, workersClaimed: 0, diagnosticReason: 'no_pending_tasks' as any });
    const entries = readClaimLogs();
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ event: 'claim_empty', slotsRequested: 2, workersClaimed: 0 });
    expect(existsSync(join(home, 'logs', 'claims.log'))).toBe(true);
  });

  test('readClaimLogs never throws, even with no log yet in a fresh home', () => {
    const prev = process.env.BUILDD_HOME;
    const fresh = mkdtempSync(join(tmpdir(), 'buildd-home-read-paths-fresh-'));
    process.env.BUILDD_HOME = fresh;
    try {
      expect(readClaimLogs()).toEqual([]);
    } finally {
      process.env.BUILDD_HOME = prev;
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('readSessionLogs returns what sessionLog wrote', () => {
    sessionLog('read-path-worker', 'warn', 'probe_event', 'detail');
    const entries = readSessionLogs('read-path-worker');
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ level: 'warn', event: 'probe_event', workerId: 'read-path-worker' });
  });
});

describe('worker-store reads', () => {
  test('loadWorker returns what saveWorker wrote', () => {
    saveWorker(worker('read-path-worker'));
    expect(loadWorker('read-path-worker')?.taskId).toBe('read-path-worker-task');
  });
});

describe('history-store reads', () => {
  test('getSession and getArchivedData return what archiveSession wrote', async () => {
    initHistory();
    archiveSession(worker('read-path-archived'));
    expect(getSession('read-path-archived')?.id).toBe('read-path-archived');
    // The archive blob is written with Bun.write (not awaited by the store).
    const deadline = Date.now() + 2000;
    let data: any = null;
    while (Date.now() < deadline && !(data = getArchivedData('read-path-archived'))) {
      await Bun.sleep(20);
    }
    expect(data).not.toBeNull();
  });
});

describe('outbox reads', () => {
  test('a new Outbox loads the entries a previous one saved', () => {
    const first = new Outbox();
    first.enqueue('PATCH', '/api/workers/read-path-worker', '{}');
    expect(first.count()).toBe(1);
    expect(new Outbox().count()).toBe(1);
  });
});
