/**
 * Unit tests for git-operations.ts — specifically the setupWorktree function.
 *
 * Regression guard: worktrees need `bun install` run after creation so that
 * workspace package symlinks (@buildd/core, @buildd/shared, etc.) are present.
 * Without it, deep imports like '@buildd/core/db' fail because Bun's module
 * resolution only traverses upward through the worktree directory tree, never
 * reaching the parent repo's nested node_modules where the symlinks live.
 *
 * The install runs async (execFile) with --frozen-lockfile, falling back to an
 * unfrozen install if the lockfile drifted; both attempts are non-fatal.
 *
 * Run: bun test apps/runner/__tests__/unit/git-operations.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ─── Mocks (must be set up before any import of the module under test) ────────

type SyncCall = { cmd: string; opts: Record<string, unknown> };
type FileCall = { file: string; args: string[]; opts: Record<string, unknown> };

const syncCalls: SyncCall[] = [];
const fileCalls: FileCall[] = [];
let existsSyncMap: Record<string, boolean> = {};

// Which bun-install invocations should fail. `frozen` = the `--frozen-lockfile`
// attempt; `unfrozen` = the plain retry. Toggled per-test to exercise fallback
// and total-failure paths without re-importing the module under test.
let failBunInstall: { frozen: boolean; unfrozen: boolean } = { frozen: false, unfrozen: false };

mock.module('child_process', () => ({
  execSync: (cmd: string, opts: Record<string, unknown>) => {
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
    return '';
  },
  // Node callback convention so promisify(execFile) resolves/rejects correctly.
  execFile: (
    file: string,
    args: string[],
    _opts: Record<string, unknown>,
    cb: (err: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    fileCalls.push({ file, args, opts: _opts });
    const frozen = args.includes('--frozen-lockfile');
    if (frozen && failBunInstall.frozen) return cb(new Error('lockfile drifted'));
    if (!frozen && failBunInstall.unfrozen) return cb(new Error('bun: command not found'));
    return cb(null, '', '');
  },
}));

mock.module('fs', () => ({
  existsSync: (p: string) => existsSyncMap[p] ?? false,
  mkdirSync: () => {},
  readFileSync: () => '# exclude\n',
  appendFileSync: () => {},
  rmSync: () => {},
}));

// Import after mocking so the module sees the mocked child_process / fs
const { setupWorktree } = await import('../../src/git-operations');

const WORKTREE_PATH = '/repo/.buildd-worktrees/buildd_test-branch';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('setupWorktree', () => {
  beforeEach(() => {
    syncCalls.length = 0;
    fileCalls.length = 0;
    existsSyncMap = {};
    failBunInstall = { frozen: false, unfrozen: false };
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
    expect(result).toBe(WORKTREE_PATH);
  });

  test('returns the worktree path even if both bun installs fail (non-fatal)', async () => {
    failBunInstall = { frozen: true, unfrozen: true };

    const result = await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');

    // Both attempts were made...
    expect(fileCalls.filter(c => c.file === 'bun' && c.args[0] === 'install').length).toBe(2);
    // ...and the failure is swallowed: the worktree path is still returned so the
    // worker can proceed (imports may break, but that is warned, not fatal).
    expect(result).toBe(WORKTREE_PATH);
  });
});
