/**
 * The runner's git checks never hold its event loop.
 *
 * The runner serves its local socket (`buildd top`, the local UI) from the same
 * thread that runs the repo scan and the per-worker sync tick. Those used to
 * run git through execSync, so a slow git (a big `diff -M`, or one `git remote
 * get-url` per directory across many repos) froze every request for as long
 * as git took. Here a fake `git` on PATH sleeps before exec'ing the real one,
 * and a request to a socket served from this process must still be answered
 * at once while the scan or the tick is waiting on it.
 *
 * The baseline test runs the old shape (a sync git call) under the same
 * harness and shows the request waiting the full sleep, so this file can fail.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/git-off-event-loop.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

mock.module('../../src/worker-store', () => ({
  saveWorker: mock(() => {}),
  loadAllWorkers: mock(() => []),
}));
mock.module('../../src/git-operations', () => ({
  cleanupWorktree: mock(async () => {}),
  removeWorktreeIfUnowned: mock(async () => {}),
}));
mock.module('../../src/session-logger', () => ({ sessionLog: mock(() => {}) }));

import { execFileSync, execSync } from 'child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createWorkspaceResolver, getGitRemote } from '../../src/workspace';
import { WorkerSync, type WorkerSyncContext } from '../../src/worker-sync';
import { gitArgsAsync } from '../../src/git-async';
import { initTestWorkspace, cleanupTestWorkspace } from '../test-workspace';

const SLEEP_S = 3;
/** A request the event loop is free to answer comes back in a few ms. */
const ANSWER_WITHIN_MS = 200;

const REAL_GIT = execSync('command -v git', { encoding: 'utf-8' }).trim();
const ORIGINAL_PATH = process.env.PATH;

let tmp: string;
let binDir: string;
let socketPath: string;
let server: ReturnType<typeof Bun.serve>;
let gitLog: string;

/** git as the test sets it up: the real binary, never the slow fake. */
const realGit = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo(dir: string, remote: string) {
  mkdirSync(dir, { recursive: true });
  realGit(dir, 'init', '-q', '-b', 'dev');
  realGit(dir, 'remote', 'add', 'origin', remote);
  writeFileSync(join(dir, 'a.ts'), 'a\n');
  realGit(dir, 'add', '-A');
  realGit(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
}

/** Time one request to the socket (a stand-in for the runner's local socket, same event loop). */
async function timeRequest(): Promise<number> {
  const t0 = performance.now();
  const res = await fetch('http://localhost/api/runner', { unix: socketPath } as RequestInit);
  await res.text();
  return performance.now() - t0;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeAll(() => {
  tmp = initTestWorkspace();
  binDir = join(tmp, 'bin');
  mkdirSync(binDir);
  gitLog = join(tmp, 'git-calls.log');
  // In directories whose path says "slow", the commands the field evidence
  // caught (the scan's `remote get-url`, the sweep's `status` / `diff`) sleep
  // first; then the real git runs.
  writeFileSync(join(binDir, 'git'), [
    '#!/bin/sh',
    `echo "$PWD $*" >> "${gitLog}"`,
    `case "$PWD" in *slow*) case "$1" in remote|status|diff) sleep ${SLEEP_S};; esac;; esac`,
    `exec "${REAL_GIT}" "$@"`,
    '',
  ].join('\n'));
  chmodSync(join(binDir, 'git'), 0o755);
  socketPath = join(tmp, 'runner.sock');
  server = Bun.serve({ unix: socketPath, fetch: () => Response.json({ ok: true }) });
  process.env.PATH = `${binDir}:${ORIGINAL_PATH}`;
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  server?.stop(true);
  cleanupTestWorkspace();
});

const gitCalls = (): string[] => {
  try { return require('fs').readFileSync(gitLog, 'utf-8').split('\n').filter(Boolean); } catch { return []; }
};
const clearGitCalls = () => writeFileSync(gitLog, '');

describe('fake git harness', () => {
  test('the fake git on PATH is the one the helpers run, and it is slow in a slow dir', async () => {
    const dir = join(tmp, 'harness-slow');
    makeRepo(dir, 'https://github.com/acme/harness.git');
    clearGitCalls();
    const t0 = performance.now();
    expect((await gitArgsAsync(['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 10_000 })).trim()).toBe('https://github.com/acme/harness.git');
    expect(performance.now() - t0).toBeGreaterThan(SLEEP_S * 1000 - 300);
    expect(gitCalls().some(l => l.includes('remote get-url origin'))).toBe(true);
  }, 15_000);

  test('baseline: a sync git call holds the socket for the whole sleep (what this replaces)', async () => {
    const dir = join(tmp, 'baseline-slow');
    makeRepo(dir, 'https://github.com/acme/baseline.git');
    // Start the request, then block the loop before it can be answered.
    const pending = timeRequest();
    getGitRemote(dir);
    const ms = await pending;
    console.log(`[latency] sync git (baseline): socket answered in ${ms.toFixed(1)}ms`);
    expect(ms).toBeGreaterThan(SLEEP_S * 1000 - 500);
  }, 15_000);

  test('a git that outlives its timeout is killed and the call rejects at the timeout', async () => {
    const dir = join(tmp, 'timeout-slow');
    makeRepo(dir, 'https://github.com/acme/t.git');
    const t0 = performance.now();
    await expect(gitArgsAsync(['status', '--porcelain'], { cwd: dir, timeoutMs: 300 })).rejects.toThrow(/timed out after 300ms/);
    expect(performance.now() - t0).toBeLessThan(1500);
  }, 10_000);
});

describe('repo scan', () => {
  test('the socket answers while the scan waits on a slow git in every directory', async () => {
    const root = join(tmp, 'roots-slow');
    for (const name of ['one', 'two', 'three']) makeRepo(join(root, name), `https://github.com/acme/${name}.git`);
    const resolver = createWorkspaceResolver(root);

    const scan = resolver.scanGitRepos();
    await sleep(50);
    const latencies = [await timeRequest(), await timeRequest(), await timeRequest()];
    console.log(`[latency] during repo scan: ${latencies.map(ms => ms.toFixed(1)).join(', ')}ms`);
    for (const ms of latencies) expect(ms).toBeLessThan(ANSWER_WITHIN_MS);

    const repos = await scan;
    expect(repos.map(r => r.normalizedUrl).sort()).toEqual(['acme/one', 'acme/three', 'acme/two']);
  }, 30_000);

  test('a scan is reused within its TTL: the heartbeat does not rescan every repo', async () => {
    const root = join(tmp, 'roots-ttl');
    for (const name of ['alpha', 'beta']) makeRepo(join(root, name), `https://github.com/acme/${name}.git`);
    const resolver = createWorkspaceResolver(root);
    clearGitCalls();

    // Before any scan the sync accessor answers at once, with nothing, and starts one.
    expect(resolver.cachedGitRepos!()).toEqual([]);
    const first = await resolver.scanGitRepos();
    const afterFirst = gitCalls().length;
    expect(afterFirst).toBe(2);

    // Many heartbeats' worth of reads: no new git.
    for (let i = 0; i < 5; i++) {
      expect(resolver.cachedGitRepos!().length).toBe(2);
      await resolver.scanGitRepos();
      await resolver.warmGitCache!();
    }
    expect(gitCalls().length).toBe(afterFirst);
    expect(resolver.resolve({ id: 'ws', name: 'nomatch', repo: 'acme/beta' })).toBe(join(root, 'beta'));
    expect(gitCalls().length).toBe(afterFirst);

    // A forced rescan (the local API's rescan, a clone) runs git again.
    await resolver.scanGitRepos({ maxAgeMs: 0 });
    expect(gitCalls().length).toBe(afterFirst + 2);
    expect(first.length).toBe(2);
  }, 30_000);

  test('concurrent readers share one scan', async () => {
    const root = join(tmp, 'roots-shared');
    for (const name of ['p', 'q']) makeRepo(join(root, name), `https://github.com/acme/${name}.git`);
    const resolver = createWorkspaceResolver(root);
    clearGitCalls();
    await Promise.all([resolver.scanGitRepos(), resolver.scanGitRepos(), resolver.warmGitCache!()]);
    expect(gitCalls().length).toBe(2);
  }, 30_000);

  test('a repo cloned by hand is found by the claim once the snapshot is older than the claim bar', async () => {
    const root = join(tmp, 'roots-late');
    makeRepo(join(root, 'early'), 'https://github.com/acme/early.git');
    const resolver = createWorkspaceResolver(root);
    await resolver.scanGitRepos();
    makeRepo(join(root, 'late-clone'), 'https://github.com/acme/late.git');
    // Within the bar the snapshot is reused...
    await resolver.warmGitCache!({ maxAgeMs: 60_000 });
    expect(resolver.cachedGitRepos!().some(r => r.normalizedUrl === 'acme/late')).toBe(false);
    // ...past it (maxAgeMs 0 stands in for "older than the bar") it is rescanned.
    await resolver.warmGitCache!({ maxAgeMs: 0 });
    expect(resolver.resolve({ id: 'ws', name: 'x', repo: 'https://github.com/acme/late.git' })).toBe(join(root, 'late-clone'));
  }, 30_000);
});

describe('worker sync tick', () => {
  function makeWorker(id: string, worktreePath: string): any {
    return {
      id, taskId: `task-${id}`, status: 'working', currentAction: '', milestones: [], subagentTasks: [],
      phaseText: '', phaseToolCount: 0, startedAt: Date.now() - 1000, lastActivity: Date.now(),
      worktreePath, prBaseRef: 'origin/dev', branch: 'buildd/x',
    };
  }

  function makeSync(workers: any[], updateWorker: (id: string, u: any) => Promise<any>) {
    const ctx: WorkerSyncContext = {
      config: { localUiUrl: 'http://localhost:8766' } as any,
      buildd: { updateWorker } as any,
      workers: new Map(workers.map(w => [w.id, w])),
      sessions: new Map(),
      dirtyWorkers: new Set<string>(workers.map(w => w.id)),
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

  test('the socket answers while a tick waits on a slow worktree, and a fast worker is not held behind it', async () => {
    const slow = join(tmp, 'wt-slow');
    const fast = join(tmp, 'wt-fast');
    makeRepo(slow, 'https://github.com/acme/s.git');
    makeRepo(fast, 'https://github.com/acme/f.git');
    writeFileSync(join(slow, 'a.ts'), 'edited\n');

    const syncedAt = new Map<string, number>();
    const payloads = new Map<string, any>();
    const sync = makeSync([makeWorker('w-slow', slow), makeWorker('w-fast', fast)], async (id, u) => {
      syncedAt.set(id, performance.now());
      payloads.set(id, u);
      return {};
    });

    const t0 = performance.now();
    const tick = sync.syncToServer();
    await sleep(50);
    const latencies = [await timeRequest(), await timeRequest(), await timeRequest()];
    console.log(`[latency] during sync tick: ${latencies.map(ms => ms.toFixed(1)).join(', ')}ms`);
    for (const ms of latencies) expect(ms).toBeLessThan(ANSWER_WITHIN_MS);

    await tick;
    // The fast worker synced long before the slow one's git finished.
    expect(syncedAt.get('w-fast')! - t0).toBeLessThan(SLEEP_S * 1000);
    expect(syncedAt.get('w-slow')! - t0).toBeGreaterThan(SLEEP_S * 1000);
    // Same answers as the sync implementation gave.
    expect(payloads.get('w-slow').dirtyWorktree).toBe(true);
    expect(payloads.get('w-fast').dirtyWorktree).toBe(false);
  }, 60_000);

  test('a second sync of the same worker while its git is still running shares the read', async () => {
    const dir = join(tmp, 'wt-shared-slow');
    makeRepo(dir, 'https://github.com/acme/shared.git');
    const worker = makeWorker('w-shared', dir);
    const sync = makeSync([worker], async () => ({}));
    clearGitCalls();
    await Promise.all([sync.syncWorkerToServer(worker), sync.syncWorkerToServer(worker)]);
    const statusCalls = gitCalls().filter(l => l.includes('wt-shared-slow') && l.endsWith('status --porcelain'));
    expect(statusCalls.length).toBe(1);
  }, 60_000);
});
