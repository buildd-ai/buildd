/**
 * Cloud: the session starts before the dependency install ends (deps-gate.ts),
 * and the install's outcome is still surfaced the way an inline one is —
 * degraded flag + trace for drift/timeout/unknown, a failed worker for
 * registry-auth / toolchain-missing (before the start if it lands first,
 * an aborted session if it lands after).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/deferred-install-surfacing.test.ts
 */

import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test';

const BRANCH = 'buildd/0000abcd-slug';
const WT = '/tmp/example-worktree';

type Outcome = Record<string, unknown>;
let resolveInstall: (o: Outcome) => void = () => {};
let installStarted = false;
let deferredMode = true;

const setup = mock(async () => ({
  path: WT, branch: BRANCH, base: 'origin/dev',
  ...(deferredMode
    ? {
        install: { status: 'skipped', reason: 'deferred' },
        deferredInstall: () => {
          installStarted = true;
          return new Promise<Outcome>((r) => { resolveInstall = r; });
        },
      }
    : { install: { status: 'ok', dirs: ['.'] } }),
}));
const cleanup = mock(async () => ({ removed: true }));

mock.module('../../src/git-operations', () => ({
  setupWorktree: setup,
  removeWorktreeIfUnowned: cleanup,
  removeWorktreeIfUnownedSync: mock(() => ({ removed: true })),
  cleanupWorktree: cleanup,
  collectGitStats: async () => ({}),
}));
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {}, loadAllWorkers: () => [], loadTerminalWorkersCached: () => [], __resetDiskWorkersCache: () => {}, loadWorker: () => null, deleteWorker: () => {},
}));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({}), checkMcpPreFlight: () => ({ warnings: [] }),
  parseMcpJson: () => [], scanMcpServersRich: () => [],
  checkBwrapSupport: () => true, checkBwrapMountIsolationSupport: () => true,
}));

const { WorkerManager } = await import('../../src/workers');

function harness(taskExtras: Record<string, unknown> = {}) {
  const updates: Array<{ id: string; payload: any }> = [];
  const milestones: any[] = [];
  const manager = Object.create(WorkerManager.prototype) as any;
  Object.assign(manager, {
    workers: new Map(), workerTeamKeys: new Map(), credCache: new Map(), sessions: new Map(),
    config: {},
    buildd: { updateWorker: mock(async (id: string, payload: any) => { updates.push({ id, payload }); return payload.branch ? { branch: payload.branch } : {}; }) },
    sendHeartbeat: () => {}, emit: () => {},
    addMilestone: (_w: any, m: any) => { milestones.push(m); },
    pusherManager: { subscribeToWorker: () => {} },
    // A live session, as startSession would register it.
    startSession: mock(async (w: any) => { manager.sessions.set(w.id, {}); }),
    abort: mock(async (id: string, reason: string) => {
      const w = manager.workers.get(id);
      w.status = 'error';
      w.error = reason;
    }),
  });
  const start = () => manager.startFromClaim(
    { id: 'worker-test', branch: BRANCH },
    {
      id: 'task-test', title: 'Example', workspaceId: 'workspace-test',
      workspace: { name: 'Example', repo: 'https://github.com/example/repo', gitConfig: { defaultBranch: 'dev' } },
      ...taskExtras,
    },
    '/tmp/example-repo',
  );
  return { manager, start, updates, milestones };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
let prevExecutor: string | undefined;

beforeEach(() => {
  setup.mockClear();
  installStarted = false;
  deferredMode = true;
  prevExecutor = process.env.BUILDD_EXECUTOR;
  process.env.BUILDD_EXECUTOR = 'cloud';
});
afterEach(() => {
  if (prevExecutor === undefined) delete process.env.BUILDD_EXECUTOR; else process.env.BUILDD_EXECUTOR = prevExecutor;
});

const traced = (updates: Array<{ payload: any }>) =>
  updates.flatMap(u => (u.payload.appendErrorTraces ?? []) as Array<{ pattern: string }>).some(t => t.pattern === 'worktree_install_failed');

describe('cloud: the session does not wait for the install', () => {
  test('asks setupWorktree to defer, and starts the session while the install is still running', async () => {
    const { manager, start } = harness();
    await start();
    await settle();
    expect((setup.mock.calls[0] as unknown[])[8]).toEqual({ deferInstall: true });
    expect(installStarted).toBe(true);
    expect(manager.startSession).toHaveBeenCalledTimes(1); // install still pending
    resolveInstall({ status: 'ok', dirs: ['.'] });
    await settle();
    expect(manager.workers.get('worker-test').status).not.toBe('error');
  });

  test('a host runner does not defer', async () => {
    delete process.env.BUILDD_EXECUTOR;
    deferredMode = false;
    const { start } = harness();
    await start();
    await settle();
    expect((setup.mock.calls[0] as unknown[])[8]).toEqual({ deferInstall: false });
  });

  test('a non-structural failure after the start degrades visibly and does not stop the session', async () => {
    const { manager, start, updates, milestones } = harness();
    await start();
    await settle();
    resolveInstall({ status: 'failed', dir: '.', failure: 'lockfile-drift', message: 'ERR_PNPM_OUTDATED_LOCKFILE' });
    await settle();
    const w = manager.workers.get('worker-test');
    expect(w.envDegraded).toEqual({ phase: 'install', failure: 'lockfile-drift', dir: '.' });
    expect(traced(updates)).toBe(true);
    expect(milestones.some(m => String(m.label).includes('Dependency install failed'))).toBe(true);
    expect(manager.abort).not.toHaveBeenCalled();
  });

  for (const failure of ['registry-auth', 'toolchain-missing'] as const) {
    test(`${failure} after the start aborts the session with the same block text`, async () => {
      const { manager, start, updates } = harness();
      await start();
      await settle();
      resolveInstall({ status: 'failed', dir: '.', failure, message: 'boom' });
      await settle();
      expect(manager.abort).toHaveBeenCalledTimes(1);
      const [, reason] = manager.abort.mock.calls[0] as [string, string];
      expect(reason).toContain(failure);
      expect(traced(updates)).toBe(true);
    });
  }

  test('codex has no Bash gate: it waits for the install before starting, and a structural failure blocks the start', async () => {
    const { manager, start } = harness({ backend: 'codex' });
    const started = start();
    await settle();
    expect(manager.startSession).not.toHaveBeenCalled();
    resolveInstall({ status: 'failed', dir: '.', failure: 'toolchain-missing', message: 'spawn pnpm ENOENT' });
    await started;
    await settle();
    expect(manager.startSession).not.toHaveBeenCalled();
    const w = manager.workers.get('worker-test');
    expect(w.status).toBe('error');
    expect(w.error).toContain('toolchain-missing');
  });
});
