/**
 * Unit tests for git-operations.ts — specifically the setupWorktree function.
 *
 * Regression guard: worktrees need `bun install` run after creation so that
 * workspace package symlinks (@buildd/core, @buildd/shared, etc.) are present.
 * Without them, deep imports like '@buildd/core/db' fail because Bun's module
 * resolution only traverses upward through the worktree directory tree, never
 * reaching the parent repo's nested node_modules where the symlinks live.
 *
 * The install runs async (execFile) with --frozen-lockfile, falling back to an
 * unfrozen install if the lockfile drifted; both attempts are non-fatal.
 *
 * Run: bun test apps/runner/__tests__/unit/git-operations.test.ts
 */

import { describe, test, expect, afterAll, beforeEach } from 'bun:test';

// ─── Mock state ───────────────────────────────────────────────────────────────

type SyncCall = { cmd: string; opts: Record<string, unknown> };
type FileCall = { file: string; args: string[]; opts: Record<string, unknown> };

const syncCalls: SyncCall[] = [];
const fileCalls: FileCall[] = [];
let existsSyncMap: Record<string, boolean> = {};

// Which bun-install invocations should fail. `frozen` = the `--frozen-lockfile`
// attempt; `unfrozen` = the plain retry. Toggled per-test to exercise fallback
// and total-failure paths without re-importing the module under test.
let failBunInstall: { frozen: boolean; unfrozen: boolean } = { frozen: false, unfrozen: false };

// Controls what `git rev-list --count` returns for fetchBranch probes.
// 'ok'      → returns a small count (branch exists, not diverged)
// 'missing' → throws (origin/<candidate> ref not found)
// 'diverged' → returns a large count (>50 commits ahead of default)
let revListBehavior: 'ok' | 'missing' | 'diverged' = 'ok';

// Controls `git worktree list --porcelain`: which paths/branches are already
// registered as worktrees of this repo. Empty = nothing known to be held.
let worktreeListOutput = '';

// Controls `git status --porcelain` run inside an existing worktree directory.
// Non-empty = that tree has uncommitted changes and must not be force-removed.
let statusPorcelain = '';
// When true the status probe itself fails (timeout, corrupt index) — an
// inconclusive answer, which must not be read as "clean".
let statusFails = false;

function mockExecSync(cmd: string, opts: Record<string, unknown>) {
  syncCalls.push({ cmd, opts });
  if (cmd.includes('worktree list --porcelain')) return worktreeListOutput;
  if (cmd.includes('status --porcelain')) {
    if (statusFails) {
      const err: any = new Error('fatal: not a git repository');
      err.status = 128;
      throw err;
    }
    return statusPorcelain;
  }
  // git sparse-checkout list on a non-sparse repo exits non-zero (throws)
  if (cmd.includes('sparse-checkout list')) {
    const err: any = new Error('this worktree is not sparse');
    err.status = 1;
    throw err;
  }
  // git branch -D when the branch doesn't exist locally yet
  if (cmd.includes('branch -D')) {
    const err: any = new Error('error: branch not found');
    err.status = 1;
    throw err;
  }
  // git rev-list --count: used by fetchBranch to verify resume candidate exists
  if (cmd.includes('rev-list --count')) {
    if (revListBehavior === 'missing') {
      const err: any = new Error('unknown revision or path not in the working tree');
      err.status = 128;
      throw err;
    }
    if (revListBehavior === 'diverged') return '100';
    return '5'; // ok — branch exists, not diverged
  }
  return '';
}

// Node callback convention so the new Promise wrapper resolves/rejects correctly.
function mockExecFile(
  file: string,
  args: string[],
  _opts: Record<string, unknown>,
  cb: (err: Error | null, stdout?: string, stderr?: string) => void,
) {
  fileCalls.push({ file, args, opts: _opts });
  const frozen = args.includes('--frozen-lockfile');
  if (frozen && failBunInstall.frozen) return cb(new Error('lockfile drifted'));
  if (!frozen && failBunInstall.unfrozen) return cb(new Error('bun: command not found'));
  return cb(null, '', '');
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

// Use require() (CJS) instead of await import() to load the real git-operations
// module, bypassing the ES module mock registry. waiting-worktree-eviction.test.ts
// installs mock.module('../../src/git-operations') which only affects ES imports;
// require() always returns the real module regardless of mock.module() state.
// This avoids the top-level await race where other files' mock.module() calls can
// run during the await and replace the module before it resolves.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupWorktree, __setGitOpsDeps, __resetGitOpsDeps } = require('../../src/git-operations');

// Inject mocks before any test runs. Uses the exported dep-injection hook so
// the test works regardless of bun version and mock.module registry state.
__setGitOpsDeps({
  execSync: mockExecSync as any,
  execFile: mockExecFile as any,
  existsSync: (p: string) => existsSyncMap[p] ?? false,
  mkdirSync: () => {},
  readFileSync: () => '# exclude\n' as any,
  appendFileSync: () => {},
  rmSync: () => {},
});

afterAll(() => {
  __resetGitOpsDeps();
});

const WORKTREE_PATH = '/repo/.buildd-worktrees/buildd_test-branch';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('setupWorktree', () => {
  beforeEach(() => {
    syncCalls.length = 0;
    fileCalls.length = 0;
    existsSyncMap = {};
    failBunInstall = { frozen: false, unfrozen: false };
    revListBehavior = 'ok';
    worktreeListOutput = '';
    statusPorcelain = '';
    statusFails = false;
    // Re-inject each test to reset mocks to initial state (clears per-test overrides
    // like custom execSync functions set in the stale-branch guard tests).
    __setGitOpsDeps({
      execSync: mockExecSync as any,
      execFile: mockExecFile as any,
      existsSync: (p: string) => existsSyncMap[p] ?? false,
      mkdirSync: () => {},
      readFileSync: () => '# exclude\n' as any,
      appendFileSync: () => {},
      rmSync: () => {},
    });
  });

  test('runs bun install in the worktree after git worktree add', async () => {
    await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');

    const install = fileCalls.find(c => c.file === 'bun' && c.args[0] === 'install');
    expect(install).toBeTruthy();
  });

  test('bun install runs in the worktree path, not the parent repo', async () => {
    await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');

    const install = fileCalls.find(c => c.file === 'bun' && c.args[0] === 'install');
    expect(install).toBeTruthy();
    // cwd must be the worktree directory (branch name is sanitized: / → _)
    expect(install!.opts.cwd).toBe(WORKTREE_PATH);
  });

  test('bun install uses --frozen-lockfile on the first attempt', async () => {
    await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');

    const first = fileCalls.find(c => c.file === 'bun' && c.args[0] === 'install');
    expect(first!.args).toContain('--frozen-lockfile');
  });

  test('bun install runs AFTER git worktree add (ordering)', async () => {
    await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');

    const addIdx = syncCalls.findIndex(c => c.cmd.includes('git worktree add'));
    expect(addIdx).toBeGreaterThanOrEqual(0);
    // git worktree add is the last sync call; the install happens after it.
    expect(fileCalls.length).toBeGreaterThan(0);
    expect(addIdx).toBe(syncCalls.length - 1);
  });

  test('falls back to an unfrozen install when the frozen lockfile install fails', async () => {
    failBunInstall = { frozen: true, unfrozen: false };

    const result = await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');

    const frozen = fileCalls.find(c => c.args.includes('--frozen-lockfile'));
    const unfrozen = fileCalls.find(c => c.file === 'bun' && c.args[0] === 'install' && !c.args.includes('--frozen-lockfile'));
    expect(frozen).toBeTruthy();
    expect(unfrozen).toBeTruthy();
    // Setup still succeeds — the unfrozen retry created node_modules.
    expect(result?.path).toBe(WORKTREE_PATH);
  });

  test('returns the worktree path even if both bun installs fail (non-fatal)', async () => {
    failBunInstall = { frozen: true, unfrozen: true };

    const result = await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');

    // Both attempts were made...
    expect(fileCalls.filter(c => c.file === 'bun' && c.args[0] === 'install').length).toBe(2);
    // ...and the failure is swallowed: the worktree path is still returned so the
    // worker can proceed (imports may break, but that is warned, not fatal).
    expect(result?.path).toBe(WORKTREE_PATH);
  });

  // ─── Resume-branch tests ───────────────────────────────────────────────────
  // Regression guard for the "retry workers cut a fresh branch" defect:
  // When context.resumeBranch is set and the branch exists on remote, the
  // worktree must check out THAT branch — not a new one built from the retry
  // task's own ID. Without this fix, retry workers opened duplicate PRs with
  // only the delta commits rather than updating the original PR.

  test('no resumeBranch: returns task branch and worktree path', async () => {
    const result = await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');

    expect(result?.path).toBe(WORKTREE_PATH);
    expect(result?.branch).toBe('buildd/test-branch');
    expect(result?.fallback).toBeUndefined();
  });

  test('resumeBranch present on remote: checks out resume branch, not task branch', async () => {
    // revListBehavior = 'ok' (default) → fetchBranch returns 'ok' → branch reused
    const context = { resumeBranch: 'buildd/prior-task-branch' };

    const result = await setupWorktree('/repo', 'buildd/retry-task-branch', 'main', 'worker-2', context);

    // The returned branch must be the resume branch, not the task's own branch
    expect(result?.branch).toBe('buildd/prior-task-branch');
    // The worktree add command must use the resume branch name
    const addCmd = syncCalls.find(c => c.cmd.includes('git worktree add'));
    expect(addCmd?.cmd).toContain('buildd/prior-task-branch');
    expect(addCmd?.cmd).toContain('origin/buildd/prior-task-branch');
    // The task's own branch must NOT be checked out
    expect(addCmd?.cmd).not.toContain('buildd/retry-task-branch');
    // No fallback — resume succeeded
    expect(result?.fallback).toBeUndefined();
  });

  test('resumeBranch missing on remote: falls back to fresh branch, populates fallback', async () => {
    revListBehavior = 'missing'; // fetchBranch returns 'missing'
    const context: Record<string, unknown> = {
      resumeBranch: 'buildd/gone-branch',
      lastCommitSha: 'abc123',
      failureContext: 'tests failed',
    };

    const result = await setupWorktree('/repo', 'buildd/retry-task-branch', 'main', 'worker-3', context);

    // Fresh start: task's own branch is used
    expect(result?.branch).toBe('buildd/retry-task-branch');
    // Fallback info populated so caller can surface a visible warning
    expect(result?.fallback).toEqual({ candidate: 'buildd/gone-branch', reason: 'missing' });
    // Resume context fields cleared so prompt-building doesn't reference the gone branch
    expect(context.resumeBranch).toBeUndefined();
    expect(context.lastCommitSha).toBeUndefined();
    expect(context.failureContext).toBeUndefined();
  });

  test('resumeBranch diverged: falls back to fresh branch, populates fallback', async () => {
    revListBehavior = 'diverged'; // fetchBranch returns 'diverged'
    const context = { resumeBranch: 'buildd/diverged-branch' };

    const result = await setupWorktree('/repo', 'buildd/retry-task-branch', 'main', 'worker-4', context);

    expect(result?.branch).toBe('buildd/retry-task-branch');
    expect(result?.fallback).toEqual({ candidate: 'buildd/diverged-branch', reason: 'diverged' });
  });

  test('baseBranch (legacy CI retry field): honored when resumeBranch absent', async () => {
    // revListBehavior = 'ok' (default)
    const context = { baseBranch: 'buildd/legacy-prior-branch' };

    const result = await setupWorktree('/repo', 'buildd/retry-task-branch', 'main', 'worker-5', context);

    expect(result?.branch).toBe('buildd/legacy-prior-branch');
    const addCmd = syncCalls.find(c => c.cmd.includes('git worktree add'));
    expect(addCmd?.cmd).toContain('buildd/legacy-prior-branch');
    expect(addCmd?.cmd).toContain('origin/buildd/legacy-prior-branch');
  });


  // ─── Stale-base guard tests ───────────────────────────────────────────────
  // The guard warns when the ref the task will build on is far behind the
  // default branch. It must measure the RESOLVED BASE (`origin/<base>`), not
  // the main clone's HEAD: execOpts.cwd is repoPath, so `HEAD..origin/<default>`
  // described a tree nobody in this task ever touches. Advisory only — setup
  // still succeeds either way.

  /** Run `fn` with a per-test execSync override, restoring the default after. */
  async function withExecSync<T>(
    override: (cmd: string, opts: Record<string, unknown>) => unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    const deps = {
      execFile: mockExecFile as any,
      existsSync: (p: string) => existsSyncMap[p] ?? false,
      mkdirSync: () => {},
      readFileSync: () => '# exclude\n' as any,
      appendFileSync: () => {},
      rmSync: () => {},
    };
    __setGitOpsDeps({ ...deps, execSync: override as any });
    try {
      return await fn();
    } finally {
      __setGitOpsDeps({ ...deps, execSync: mockExecSync as any });
    }
  }

  /** Capture console.warn for the duration of `fn`. */
  async function captureWarns<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(' '));
    try {
      return { result: await fn(), warns };
    } finally {
      console.warn = originalWarn;
    }
  }

  test('stale-base guard: measures the resolved base ref, not the main clone HEAD', async () => {
    await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-probe', {
      resumeBranch: 'buildd/prior-task-branch',
    });

    const counts = syncCalls.filter(c => c.cmd.includes('rev-list --count')).map(c => c.cmd);
    // Measures how far the base the worktree is cut from is behind the default branch.
    expect(counts.some(c => c.includes('origin/buildd/prior-task-branch..origin/main'))).toBe(true);
    // Never measures the main clone's HEAD — an unrelated tree.
    expect(counts.some(c => c.includes('HEAD..origin/'))).toBe(false);
  });

  test('stale-base guard: probes origin/<default>..origin/<default> for a fresh task', async () => {
    await setupWorktree('/repo', 'buildd/test-branch', 'dev', 'worker-fresh-base');

    const counts = syncCalls.filter(c => c.cmd.includes('rev-list --count')).map(c => c.cmd);
    expect(counts.some(c => c.includes('origin/dev..origin/dev'))).toBe(true);
  });

  test('stale-base guard: the warning names the ref it measured', async () => {
    const staleExecSync = (cmd: string, opts: Record<string, unknown>) => {
      // The stale probe is the only rev-list whose RIGHT side is the default branch.
      if (cmd.includes('rev-list --count') && cmd.includes('..origin/main"')) return '25';
      return mockExecSync(cmd, opts);
    };

    const { result, warns } = await captureWarns(() =>
      withExecSync(staleExecSync, () =>
        setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-stale', {
          resumeBranch: 'buildd/prior-task-branch',
        }),
      ),
    );

    // Advisory only: setup still succeeded.
    expect(result?.path).toBe(WORKTREE_PATH);
    const staleWarn = warns.find(w => w.includes('25') && w.toLowerCase().includes('behind'));
    expect(staleWarn).toBeTruthy();
    // The log line says WHAT it measured, so a wrong-tree measurement is visible.
    expect(staleWarn).toContain('origin/buildd/prior-task-branch');
  });

  test('stale-base guard: no warn when the base is within tolerance', async () => {
    const freshExecSync = (cmd: string, opts: Record<string, unknown>) => {
      if (cmd.includes('rev-list --count') && cmd.includes('..origin/main"')) return '3';
      return mockExecSync(cmd, opts);
    };

    const { warns } = await captureWarns(() =>
      withExecSync(freshExecSync, () => setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-ok')),
    );

    expect(warns.find(w => w.toLowerCase().includes('behind'))).toBeUndefined();
  });

  // ─── Base-branch shapes (B10) ─────────────────────────────────────────────
  // Deliberately NOT re-tested here: `baseBranch` equal to the default branch,
  // and a branch another worktree already holds, are covered end-to-end by
  // worktree-shared-branch.test.ts against a stateful fake git (branch ledger +
  // holder paths), which is the stronger harness for them. Verified 2026-09-04:
  // both shapes produce an isolated worktree on a substitute branch, so the
  // original degrade-into-the-shared-clone failure is closed.

  // ─── Worktree-path collision (B10 residual) ───────────────────────────────
  // The worktree DIRECTORY is keyed on the requested branch, so two workers
  // asking for the same branch compute the same path even though the guard
  // above gives them distinct branches. Reclaiming that path with
  // `git worktree remove --force` exits 0 on a tree with uncommitted changes —
  // i.e. it destroys another live worker's work.

  test('does not force-remove a registered worktree that has uncommitted changes', async () => {
    existsSyncMap[WORKTREE_PATH] = true;
    worktreeListOutput = [
      'worktree /repo',
      'branch refs/heads/main',
      '',
      `worktree ${WORKTREE_PATH}`,
      'branch refs/heads/buildd/test-branch',
      '',
    ].join('\n');
    statusPorcelain = ' M apps/web/src/lib/approve-plan.ts\n';

    const result = await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-collide-99');

    // The other worker's tree survives…
    expect(syncCalls.some(c => c.cmd.includes(`worktree remove --force "${WORKTREE_PATH}"`))).toBe(false);
    // …and we get a path of our own, keyed on the worker id.
    expect(result?.path).not.toBe(WORKTREE_PATH);
    expect(result?.path).toContain('worker-c');
    const addCmd = syncCalls.find(c => c.cmd.includes('git worktree add'));
    expect(addCmd?.cmd).toContain(result!.path);
  });

  test('still reclaims a registered leftover worktree with a clean tree', async () => {
    existsSyncMap[WORKTREE_PATH] = true;
    worktreeListOutput = [
      'worktree /repo',
      'branch refs/heads/main',
      '',
      `worktree ${WORKTREE_PATH}`,
      'branch refs/heads/buildd/test-branch',
      '',
    ].join('\n');
    statusPorcelain = '';

    const result = await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-clean-1');

    expect(syncCalls.some(c => c.cmd.includes(`worktree remove --force "${WORKTREE_PATH}"`))).toBe(true);
    expect(result?.path).toBe(WORKTREE_PATH);
  });

  test('an inconclusive status probe does not authorise removal', async () => {
    // Timeout / corrupt index / git error on a REGISTERED worktree: unknown is
    // not clean. Cost of being wrong here is one extra directory; the other way
    // round it is someone's uncommitted work.
    existsSyncMap[WORKTREE_PATH] = true;
    worktreeListOutput = [
      'worktree /repo',
      'branch refs/heads/main',
      '',
      `worktree ${WORKTREE_PATH}`,
      'branch refs/heads/buildd/test-branch',
      '',
    ].join('\n');
    statusFails = true;

    const result = await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-unknown-7');

    expect(syncCalls.some(c => c.cmd.includes(`worktree remove --force "${WORKTREE_PATH}"`))).toBe(false);
    expect(result?.path).not.toBe(WORKTREE_PATH);
  });

  test('still force-removes a leftover directory that is not a registered worktree', async () => {
    existsSyncMap[WORKTREE_PATH] = true;
    worktreeListOutput = ''; // nothing registered — the dir is plain garbage

    const result = await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-garbage');

    expect(syncCalls.some(c => c.cmd.includes(`worktree remove --force "${WORKTREE_PATH}"`))).toBe(true);
    expect(result?.path).toBe(WORKTREE_PATH);
    expect(result?.branch).toBe('buildd/test-branch');
  });
});
