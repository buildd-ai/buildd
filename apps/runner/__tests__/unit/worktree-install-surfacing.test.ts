/**
 * Regression: the runner's dependency install could fail and the session would
 * start, run a full budget and report `done` with broken workspace imports —
 * invisibly. `installWorkspaceDeps` returned `void`, so the failure reached
 * nothing at all.
 *
 * The policy this locks down (fail-vs-degrade):
 *
 *  - Nothing installable → skipped, no noise. A tree with no manifest has no
 *    dependencies to break; this is what used to generate the entire
 *    false-alarm population.
 *  - A DECLARED `.buildd/env.yaml` install command → the provision gate owns it
 *    and blocks. `setupWorktree` does not install, so there is no double work.
 *  - Auto-detected + `registry-auth` / `toolchain-missing` → fail BEFORE the
 *    budget loop. The agent cannot fix a host credential or a missing runtime,
 *    and it will hit every task on this host.
 *  - Auto-detected + drift / timeout / unknown → proceed, loudly degraded. On an
 *    auto-detected repo the runner is GUESSING that install matters; plenty of
 *    tasks never import anything. Failing closed on a guess turns a per-task
 *    defect into a per-workspace outage.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worktree-install-surfacing.test.ts
 */

import { describe, expect, mock, test, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { runProvisionGate, clearProvisionGateCache } from '../../src/env-verify';

const BRANCH = 'buildd/0000abcd-slug';
const WT = '/tmp/example-worktree';

type InstallOutcome = Record<string, unknown>;
let installOutcome: InstallOutcome = { status: 'ok', dirs: ['.'] };

const cleanup = mock(async () => ({ removed: true }));
const setup = mock(async () => ({ path: WT, branch: BRANCH, base: 'origin/dev', install: installOutcome }));

mock.module('../../src/git-operations', () => ({
  setupWorktree: setup,
  removeWorktreeIfUnowned: cleanup,
  removeWorktreeIfUnownedSync: mock(() => ({ removed: true })),
  cleanupWorktree: cleanup,
  collectGitStats: async () => ({}),
}));
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {}, loadAllWorkers: () => [], loadWorker: () => null, deleteWorker: () => {},
}));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({}), checkMcpPreFlight: () => ({ warnings: [] }),
  parseMcpJson: () => [], scanMcpServersRich: () => [],
  checkBwrapSupport: () => true, checkBwrapMountIsolationSupport: () => true,
}));

const { WorkerManager } = await import('../../src/workers');

type Update = { id: string; payload: any };

function harness() {
  const updates: Update[] = [];
  const milestones: any[] = [];
  const manager = Object.create(WorkerManager.prototype) as any;
  Object.assign(manager, {
    workers: new Map(), workerTeamKeys: new Map(), credCache: new Map(),
    config: {},
    buildd: { updateWorker: mock(async (id: string, payload: any) => { updates.push({ id, payload }); return payload.branch ? { branch: payload.branch } : {}; }) },
    sendHeartbeat: () => {}, emit: () => {},
    addMilestone: (_w: any, m: any) => { milestones.push(m); },
    pusherManager: { subscribeToWorker: () => {} },
    startSession: mock(async () => {}),
  });
  const start = () => manager.startFromClaim(
    { id: 'worker-test', branch: BRANCH },
    {
      id: 'task-test', title: 'Example', workspaceId: 'workspace-test',
      workspace: { name: 'Example', repo: 'https://github.com/example/repo', gitConfig: { defaultBranch: 'dev' } },
    },
    '/tmp/example-repo',
  );
  return { manager, start, updates, milestones };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  cleanup.mockClear();
  setup.mockClear();
  installOutcome = { status: 'ok', dirs: ['.'] };
});

const traceOf = (updates: Update[], pattern: string) =>
  updates
    .flatMap(u => (u.payload.appendErrorTraces ?? []) as Array<{ pattern: string; excerpt: string }>)
    .find(t => t.pattern === pattern);

describe('degraded (auto-detected, non-structural failure)', () => {
  beforeEach(() => {
    installOutcome = { status: 'failed', dir: '.', failure: 'lockfile-drift', message: 'error: lockfile had changes' };
  });

  test('records a milestone, an error trace and a flag on the worker — and still starts', async () => {
    const { manager, start, updates, milestones } = harness();

    await start();
    await settle();

    expect(milestones.some(m => String(m.label).includes('Dependency install failed'))).toBe(true);
    const trace = traceOf(updates, 'worktree_install_failed');
    expect(trace).toBeTruthy();
    expect(trace!.excerpt).toContain('lockfile-drift');

    const worker = manager.workers.get('worker-test');
    expect(worker.envDegraded).toEqual({ phase: 'install', failure: 'lockfile-drift', dir: '.' });
    // Degraded, not blocked: a guess about whether install matters must not
    // become a per-workspace outage.
    expect(manager.startSession).toHaveBeenCalledTimes(1);
    expect(worker.status).not.toBe('error');
  });

  test('a timeout degrades the same way', async () => {
    installOutcome = { status: 'failed', dir: 'packages/api', failure: 'timeout', message: 'ETIMEDOUT' };
    const { manager, start } = harness();

    await start();
    await settle();

    expect(manager.workers.get('worker-test').envDegraded.failure).toBe('timeout');
    expect(manager.startSession).toHaveBeenCalledTimes(1);
  });
});

describe('fail-fast (structural host fault)', () => {
  for (const failure of ['registry-auth', 'toolchain-missing'] as const) {
    test(`${failure} fails the session before any budget is spent`, async () => {
      installOutcome = { status: 'failed', dir: '.', failure, message: 'boom' };
      const { manager, start, updates } = harness();

      await start();
      await settle();

      // Zero SDK work: the agent cannot fix a host credential or a missing
      // runtime, and spending a budget to produce a broken `done` is the worst
      // available outcome.
      expect(manager.startSession).not.toHaveBeenCalled();
      const worker = manager.workers.get('worker-test');
      expect(worker.status).toBe('error');
      expect(worker.error).toContain(failure);
      // Still traced, so it dedupes into one friction report per host fault.
      expect(traceOf(updates, 'worktree_install_failed')).toBeTruthy();
    });
  }
});

describe('no degradation when install was not required', () => {
  for (const outcome of [
    { status: 'skipped', reason: 'no-manifest' },
    { status: 'skipped', reason: 'non-bun-toolchain' },
    { status: 'skipped', reason: 'declared-manifest' },
    { status: 'ok', dirs: ['.'] },
  ]) {
    test(`${outcome.status}/${(outcome as any).reason ?? 'ok'} raises nothing`, async () => {
      installOutcome = outcome;
      const { manager, start, updates, milestones } = harness();

      await start();
      await settle();

      expect(milestones.some(m => String(m.label).includes('Dependency install failed'))).toBe(false);
      expect(traceOf(updates, 'worktree_install_failed')).toBeUndefined();
      expect(manager.workers.get('worker-test').envDegraded).toBeUndefined();
      expect(manager.startSession).toHaveBeenCalledTimes(1);
    });
  }
});

describe('the provision gate no longer skips the install phase', () => {
  test('workers.ts does not pass install to skipPhases', () => {
    // A regression lock, deliberately source-level: the call sits inside
    // startSession behind the whole env assembly, and the property that matters
    // is that nothing re-adds the skip. The stale justification was "the runner
    // already ran its own tolerant install" — which may legitimately have
    // installed nothing at all.
    const src = readFileSync('apps/runner/src/workers.ts', 'utf-8');
    const call = src.match(/runProvisionGate\(\{[^}]*\}\)/s);
    expect(call).toBeTruthy();
    expect(call![0]).not.toContain('skipPhases');
  });

  test('enforcement stays opt-in: an auto-detected repo is never blocked', async () => {
    clearProvisionGateCache();
    const gate = await runProvisionGate({
      root: '/wt',
      fs: { exists: (p) => p === 'bun.lock', read: () => '' },
      runCommand: () => ({ code: 1, stdout: '', stderr: 'would have failed' }),
    });

    expect(gate.enforced).toBe(false);
    expect(gate.ok).toBe(true);
  });

  test('a declared manifest whose install command fails now produces ok:false naming the install phase', async () => {
    clearProvisionGateCache();
    const gate = await runProvisionGate({
      root: '/wt',
      fs: {
        exists: (p) => p === '.buildd/env.yaml',
        read: () => 'toolchain:\n  runtime: bun\ninstall:\n  command: bun install --frozen-lockfile\n',
      },
      runCommand: (command) =>
        command.includes('install')
          ? { code: 1, stdout: '', stderr: 'error: lockfile had changes' }
          : { code: 0, stdout: '', stderr: '' },
    });

    expect(gate.enforced).toBe(true);
    expect(gate.ok).toBe(false);
    const failed = gate.steps.find(s => s.status === 'fail');
    expect(failed?.phase).toBe('install');
  });
});
