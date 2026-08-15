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

import { describe, test, expect, afterAll, beforeEach, mock } from 'bun:test';

// ─── Module isolation ─────────────────────────────────────────────────────────
// waiting-worktree-eviction.test.ts installs mock.module('../../src/git-operations')
// in the same Bun worker. That mock doesn't export __setGitOpsDeps, so we'd import
// undefined and the dep injection would silently fail. Restore the real module first.
mock.restore();

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

function mockExecSync(cmd: string, opts: Record<string, unknown>) {
  syncCalls.push({ cmd, opts });
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

// Dynamic import AFTER mock.restore() so we get the real git-operations module,
// not a sibling file's partial mock (e.g. waiting-worktree-eviction.test.ts mocks
// this module without __setGitOpsDeps, which would make the dep injection silently
// fail and cause all tests to see empty syncCalls/fileCalls).
const { setupWorktree, __setGitOpsDeps, __resetGitOpsDeps } = await import('../../src/git-operations');

// Inject mocks via the exported dep-injection hook so the test works regardless
// of bun version and without touching the shared mock.module registry (which is
// cleared by mock.restore() in sibling test files like updater.test.ts).
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
});
