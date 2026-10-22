/**
 * Early resolves wait for the first repo scan; the claim rescans once on a
 * miss before auto-cloning; the Scout advert goes out once the scan lands.
 *
 * Follow-up to git-off-event-loop.test.ts (task 25a871ec):
 *  - a retry or follow-up resolving a workspace in the first seconds after
 *    start fell into resolve()'s cold path, one synchronous git per directory;
 *  - the claim accepts a snapshot up to 60 s old, so a repo cloned by hand
 *    inside that window was missed and resolve fell through to auto-clone;
 *  - the startup heartbeat's Scout advert listed no repos until the next beat.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/resolver-first-scan.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {}, loadAllWorkers: () => [], loadTerminalWorkersCached: () => [], __resetDiskWorkersCache: () => {}, loadWorker: () => null, deleteWorker: () => {},
}));
mock.module('../../src/session-logger', () => ({ sessionLog: () => {} }));

import { execFileSync, execSync } from 'child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createWorkspaceResolver } from '../../src/workspace';
import { RecoveryManager, type RecoveryDeps } from '../../src/recovery';
import type { LocalWorker } from '../../src/types';
import { initTestWorkspace, cleanupTestWorkspace } from '../test-workspace';

const { WorkerManager } = await import('../../src/workers');

// Scans are counted by a `#!/bin/sh` git shim on PATH, which Windows cannot exec:
// there the shim is not installed and the tests that count scans are skipped.
const IS_WIN = process.platform === 'win32';
const REAL_GIT = IS_WIN ? 'git' : execSync('command -v git', { encoding: 'utf-8' }).trim();
const ORIGINAL = { PATH: process.env.PATH, GIT_ALLOW_PROTOCOL: process.env.GIT_ALLOW_PROTOCOL };
let tmp: string;
let gitLog: string;

const realGit = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
function makeRepo(dir: string, remote: string) {
  mkdirSync(dir, { recursive: true });
  realGit(dir, 'init', '-q', '-b', 'dev');
  realGit(dir, 'remote', 'add', 'origin', remote);
}
const scanCalls = () => {
  try { return readFileSync(gitLog, 'utf-8').split('\n').filter(l => l.includes('remote get-url origin')).length; } catch { return 0; }
};

beforeAll(() => {
  tmp = initTestWorkspace();
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  gitLog = join(tmp, 'git.log');
  // An auto-clone in a failing case must never reach the network.
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  if (IS_WIN) return;
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$PWD $*" >> "${gitLog}"\nexec "${REAL_GIT}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${ORIGINAL.PATH}`;
});

afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanupTestWorkspace();
});

describe('whenScanned', () => {
  test.skipIf(IS_WIN)('a cold resolver lands its first scan; afterwards it returns without scanning again', async () => {
    const root = join(tmp, 'roots-cold');
    makeRepo(join(root, 'one'), 'https://github.com/acme/one.git');
    const resolver = createWorkspaceResolver(root);
    writeFileSync(gitLog, '');
    await resolver.whenScanned!();
    expect(resolver.cachedGitRepos!().map(r => r.normalizedUrl)).toContain('acme/one');
    const after = scanCalls();
    expect(after).toBe(1);
    await resolver.whenScanned!();
    expect(scanCalls()).toBe(after);
  });
});

describe('claim: rescan once on a miss before auto-cloning', () => {
  test('a repo cloned by hand after the snapshot is found, not cloned again', async () => {
    const root = join(tmp, 'roots-hand');
    makeRepo(join(root, 'existing'), 'https://github.com/acme/existing.git');
    const resolver = createWorkspaceResolver(root);
    await resolver.warmGitCache!();
    // Cloned by hand, under a directory name that name-matching does not guess.
    makeRepo(join(root, 'my-checkout'), 'https://github.com/acme/widget.git');
    const path = await resolver.resolveAsync!({ id: 'ws-1', name: 'Widget Space', repo: 'https://github.com/acme/widget' }, null, { maxAgeMs: 60_000 });
    expect(path).toBe(join(root, 'my-checkout'));
  });

  test.skipIf(IS_WIN)('a hit in a fresh snapshot does not rescan', async () => {
    const root = join(tmp, 'roots-hit');
    makeRepo(join(root, 'existing'), 'https://github.com/acme/hit.git');
    const resolver = createWorkspaceResolver(root);
    await resolver.warmGitCache!();
    writeFileSync(gitLog, '');
    const path = await resolver.resolveAsync!({ id: 'ws-2', name: 'Hit', repo: 'https://github.com/acme/hit' }, null, { maxAgeMs: 60_000 });
    expect(path).toBe(join(root, 'existing'));
    expect(scanCalls()).toBe(0);
  });
});

function retryHarness(order: string[]) {
  const worker = {
    id: 'w-retry', taskId: 't-retry', taskTitle: 'Retry', taskDescription: 'd', workspaceId: 'ws-1', workspaceName: 'ws',
    status: 'error', milestones: [], toolCalls: [], messages: [], output: [], commits: [],
  } as unknown as LocalWorker;
  const deps = {
    workers: new Map([[worker.id, worker]]),
    sessions: new Map(),
    buildd: { updateWorker: async () => ({}) },
    resolver: {
      whenScanned: async () => { order.push('whenScanned:start'); await new Promise(r => setTimeout(r, 20)); order.push('whenScanned:end'); },
      resolve: () => { order.push('resolve'); return '/tmp/x'; },
    },
    pendingPermissionRequests: new Map(),
    emit: () => {},
    addMilestone: () => {},
    unsubscribeFromWorker: () => {},
    startSession: async () => {},
  } as unknown as RecoveryDeps;
  return { mgr: new RecoveryManager(deps), worker };
}

describe('early resolves wait for the first scan', () => {
  test('a retry resolves only after the first scan landed', async () => {
    const order: string[] = [];
    const { mgr, worker } = retryHarness(order);
    await mgr.retry(worker.id);
    expect(order.slice(0, 3)).toEqual(['whenScanned:start', 'whenScanned:end', 'resolve']);
  });

  test('a follow-up message resolves only after the first scan landed', async () => {
    const order: string[] = [];
    const manager = Object.create(WorkerManager.prototype) as any;
    const worker = {
      id: 'w-follow', taskId: 't-follow', taskTitle: 'Follow', workspaceId: 'ws-1', workspaceName: 'ws',
      status: 'done', milestones: [], toolCalls: [], messages: [], output: [], commits: [],
    };
    Object.assign(manager, {
      workers: new Map([[worker.id, worker]]),
      sessions: new Map(),
      config: {},
      buildd: { updateWorker: async () => ({}) },
      resolver: {
        whenScanned: async () => { order.push('whenScanned'); },
        resolve: () => { order.push('resolve'); return null; },
      },
      emit: () => {}, addMilestone: () => {}, sendHeartbeat: () => {},
    });
    await manager.sendMessage(worker.id, 'one more thing').catch(() => {});
    expect(order.indexOf('whenScanned')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('whenScanned')).toBeLessThan(order.indexOf('resolve'));
  });
});

describe('Scout advert after the first scan', () => {
  function manager(opts: { advert?: unknown; singleTask?: boolean }) {
    const m = Object.create(WorkerManager.prototype) as any;
    const beats: number[] = [];
    let scanned = false;
    Object.assign(m, {
      config: { singleTask: !!opts.singleTask },
      resolver: { whenScanned: async () => { await new Promise(r => setTimeout(r, 10)); scanned = true; } },
      scoutHostPoller: { advert: () => (scanned ? opts.advert : undefined) },
      sendHeartbeat: async () => { beats.push(Date.now()); },
    });
    return { m, beats };
  }

  test('beats again once the scan lands and there is an advert to send', async () => {
    const { m, beats } = manager({ advert: { repos: ['acme/one'], command: true, capture: false } });
    await m.advertiseAfterFirstScan();
    expect(beats.length).toBe(1);
  });

  test('no extra beat when the host advertises nothing', async () => {
    const { m, beats } = manager({ advert: undefined });
    await m.advertiseAfterFirstScan();
    expect(beats.length).toBe(0);
  });

  test('a single-task runner never advertises', async () => {
    const { m, beats } = manager({ advert: { repos: ['acme/one'] }, singleTask: true });
    await m.advertiseAfterFirstScan();
    expect(beats.length).toBe(0);
  });
});
