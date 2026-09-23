/**
 * Unit tests for the auto-update module.
 *
 * Run: cd apps/runner && bun test __tests__/unit/updater.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';

// nodeFs is fetched via CommonJS require (not ES module import) so it bypasses
// any mock.module('fs', ...) leakage from earlier-loaded test files — require
// always returns the real module regardless of mock.module state.
// applyUpdate accepts fsOps as an explicit parameter in tests, so the ES-module
// 'fs' binding on updater.ts doesn't matter for test correctness.
// NOTE: Do NOT call mock.restore() here — it triggers re-evaluation of
// git-operations.ts (which also imports 'fs'), resetting its __setGitOpsDeps
// injection and breaking setupWorktree tests in Bun 1.3.14+.
const nodeFs = require('fs') as typeof import('fs');
const TMP_HOME: string = nodeFs.mkdtempSync(join(require('os').tmpdir(), 'updater-home-'));

const mockExecSync = mock(() => 'abc1234\n');
mock.module('child_process', () => ({
  execSync: mockExecSync,
}));

// Import after mocking
const { getCurrentCommit, checkForUpdate, applyUpdate, rollbackTo, hasTrackedChanges, hasCommitDrift, shouldShowUpdateAvailable } = await import('../../src/updater');
import type { UpdateExecOps } from '../../src/updater';

const NODE_MODULES = join(TMP_HOME, 'node_modules');

/**
 * A fake UpdateExecOps that never touches a real git repo or spawns a real
 * `bun install` — applyUpdate/rollbackTo now run entirely through Bun.spawn
 * (see updater.ts's gitAsync/bunVersionAsync/bunInstallAsync), so mocking
 * child_process.execSync (still done above for getCurrentCommit/hasTrackedChanges,
 * which stay execSync-based) no longer reaches the apply path at all.
 */
function fakeExecOps(overrides: Partial<UpdateExecOps> = {}): UpdateExecOps {
  return {
    git: mock(async () => 'sha'),
    bunVersion: mock(async () => {}),
    bunInstall: mock(async () => {}),
    ...overrides,
  };
}

afterAll(() => {
  nodeFs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('getCurrentCommit', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  test('returns trimmed SHA from git rev-parse', () => {
    mockExecSync.mockReturnValue('abc1234def5678\n');
    const result = getCurrentCommit();
    expect(result).toBe('abc1234def5678');
    expect(mockExecSync).toHaveBeenCalledWith('git rev-parse HEAD', expect.objectContaining({
      encoding: 'utf-8',
    }));
  });

  test('returns null when git command fails', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });
    const result = getCurrentCommit();
    expect(result).toBeNull();
  });
});

describe('checkForUpdate', () => {
  test('returns true when SHAs differ', () => {
    expect(checkForUpdate('abc1234', 'def5678')).toBe(true);
  });

  test('returns false when SHAs match', () => {
    expect(checkForUpdate('abc1234', 'abc1234')).toBe(false);
  });

  test('returns false when current is null', () => {
    expect(checkForUpdate(null, 'abc1234')).toBe(false);
  });

  test('returns false when latest is null', () => {
    expect(checkForUpdate('abc1234', null)).toBe(false);
  });

  test('returns false when both are null', () => {
    expect(checkForUpdate(null, null)).toBe(false);
  });
});

describe('applyUpdate', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    // getCurrentCommit() (previousCommit/newCommit) still goes through
    // execSync — only the fetch/reset/install chain moved to Bun.spawn.
    mockExecSync.mockReturnValue('sha\n');
    // Rebuild a node_modules tree (with a stale .bun store dir) that the clean
    // reinstall is expected to blow away.
    nodeFs.rmSync(NODE_MODULES, { recursive: true, force: true });
    nodeFs.mkdirSync(join(NODE_MODULES, '.bun', '@aws-sdk+client-s3@3.1.0'), { recursive: true });
  });

  test('is async and never shells out via execSync for fetch/reset/checkout/bun', async () => {
    const execOps = fakeExecOps();
    const pending = applyUpdate(TMP_HOME, nodeFs, execOps);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    // getCurrentCommit() (a plain `git rev-parse HEAD`) still legitimately goes
    // through execSync — it's the reinstall chain that must not.
    const execSyncCmds = mockExecSync.mock.calls.map((c: any[]) => c[0]);
    for (const banned of ['fetch', 'reset', 'checkout', 'bun ']) {
      expect(execSyncCmds.some((cmd: string) => typeof cmd === 'string' && cmd.includes(banned))).toBe(false);
    }
  });

  test('clean-reinstalls: removes node_modules before a frozen bun install', async () => {
    let nodeModulesPresentAtInstall: boolean | null = null;
    const execOps = fakeExecOps({
      bunInstall: mock(async () => {
        // Ordering guarantee: node_modules must already be gone by install time.
        nodeModulesPresentAtInstall = nodeFs.existsSync(NODE_MODULES);
      }),
    });

    const result = await applyUpdate(TMP_HOME, nodeFs, execOps);

    expect(result.success).toBe(true);
    expect(execOps.bunInstall).toHaveBeenCalledWith(TMP_HOME);
    // rm happened strictly before the install ran...
    expect(nodeModulesPresentAtInstall).toBe(false);
    // ...and (since the mocked install is a no-op) the tree stays removed.
    expect(nodeFs.existsSync(NODE_MODULES)).toBe(false);
  });

  test('resets to the tracked branch and fetches before resetting', async () => {
    const execOps = fakeExecOps();
    await applyUpdate(TMP_HOME, nodeFs, execOps);

    const calls = (execOps.git as ReturnType<typeof mock>).mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContainEqual(['fetch', 'origin', 'main']);
    expect(calls).toContainEqual(['reset', '--hard', 'origin/main']);
    // fetch must precede the reset.
    const fetchIdx = calls.findIndex((c: string[]) => c[0] === 'fetch');
    const resetIdx = calls.findIndex((c: string[]) => c[0] === 'reset');
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeLessThan(resetIdx);
  });

  test('verifies bun is runnable before removing node_modules', async () => {
    const execOps = fakeExecOps({
      bunVersion: mock(async () => { throw new Error('bun: command not found'); }),
    });

    const result = await applyUpdate(TMP_HOME, nodeFs, execOps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('bun: command not found');
    // A broken bun must not leave us with a wiped tree.
    expect(nodeFs.existsSync(NODE_MODULES)).toBe(true);
  });

  test('returns failure without throwing when bun install fails after the rm', async () => {
    const execOps = fakeExecOps({
      bunInstall: mock(async () => { throw new Error('lockfile out of sync'); }),
    });

    // Preserve the contract the caller relies on: a failed reinstall never throws
    // (so the live process keeps serving) and reports success:false (so no exit 75).
    let result: any;
    await expect((async () => { result = await applyUpdate(TMP_HOME, nodeFs, execOps); })()).resolves.toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain('lockfile out of sync');
  });

  test('returns failure when git fetch fails (node_modules untouched)', async () => {
    const execOps = fakeExecOps({
      git: mock(async (args: string[]) => {
        if (args[0] === 'fetch') throw new Error('network error');
        return 'sha';
      }),
    });

    const result = await applyUpdate(TMP_HOME, nodeFs, execOps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('network error');
    // Failure occurred before the rm, so node_modules is intact.
    expect(nodeFs.existsSync(NODE_MODULES)).toBe(true);
  });
});

describe('rollbackTo', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue('sha\n');
    nodeFs.rmSync(NODE_MODULES, { recursive: true, force: true });
    nodeFs.mkdirSync(NODE_MODULES, { recursive: true });
  });

  test('resets to the given commit without fetching first', async () => {
    const execOps = fakeExecOps();
    const result = await rollbackTo('deadbeef', TMP_HOME, nodeFs, execOps);

    expect(result.success).toBe(true);
    const calls = (execOps.git as ReturnType<typeof mock>).mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContainEqual(['reset', '--hard', 'deadbeef']);
    expect(calls.some((c: string[]) => c[0] === 'fetch')).toBe(false);
  });

  test('still does a clean reinstall (removes node_modules before install)', async () => {
    let nodeModulesPresentAtInstall: boolean | null = null;
    const execOps = fakeExecOps({
      bunInstall: mock(async () => {
        nodeModulesPresentAtInstall = nodeFs.existsSync(NODE_MODULES);
      }),
    });

    await rollbackTo('deadbeef', TMP_HOME, nodeFs, execOps);
    expect(nodeModulesPresentAtInstall).toBe(false);
  });

  test('returns failure without throwing when the reset itself fails', async () => {
    const execOps = fakeExecOps({
      git: mock(async () => { throw new Error('could not resolve deadbeef'); }),
    });

    let result: any;
    await expect((async () => { result = await rollbackTo('deadbeef', TMP_HOME, nodeFs, execOps); })()).resolves.toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain('could not resolve deadbeef');
  });
});

describe('hasTrackedChanges', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  test('returns false for an untracked-only working tree (runtime artifacts)', () => {
    // --untracked-files=no means untracked files (config.json, history.db, etc.)
    // produce no output; the preflight must allow the update.
    mockExecSync.mockReturnValue('');
    const result = hasTrackedChanges('/some/install-dir');
    expect(result).toBe(false);
    expect(mockExecSync).toHaveBeenCalledWith(
      'git status --porcelain --untracked-files=no',
      expect.objectContaining({ cwd: '/some/install-dir' }),
    );
  });

  test('returns true for a modified tracked file', () => {
    mockExecSync.mockReturnValue(' M apps/runner/src/index.ts\n');
    expect(hasTrackedChanges('/some/install-dir')).toBe(true);
  });

  test('returns true for a staged (index) change', () => {
    mockExecSync.mockReturnValue('M  apps/runner/src/updater.ts\n');
    expect(hasTrackedChanges('/some/install-dir')).toBe(true);
  });

  test('returns false for a fully clean working tree', () => {
    mockExecSync.mockReturnValue('');
    expect(hasTrackedChanges('/some/install-dir')).toBe(false);
  });

  test('returns false when git command fails (update attempt will fail at git step)', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repository'); });
    expect(hasTrackedChanges('/some/install-dir')).toBe(false);
  });
});

describe('hasCommitDrift', () => {
  test('returns true when disk and process commits differ', () => {
    expect(hasCommitDrift('abc1234', 'def5678')).toBe(true);
  });

  test('returns false when disk and process commits match', () => {
    expect(hasCommitDrift('abc1234', 'abc1234')).toBe(false);
  });

  test('returns false when disk commit is unknown (git read failed)', () => {
    expect(hasCommitDrift(null, 'abc1234')).toBe(false);
  });

  test('returns false when process commit is unknown (not yet resolved at startup)', () => {
    expect(hasCommitDrift('abc1234', null)).toBe(false);
  });

  test('returns false when both are unknown', () => {
    expect(hasCommitDrift(null, null)).toBe(false);
  });
});

// The third argument is reachability, and it is REQUIRED so that a new call
// site cannot silently default to "reachable". These cases all pass `true`;
// the unreachable cases live in update-target-reachability.test.ts.
describe('shouldShowUpdateAvailable', () => {
  test('true when the changelog has entries', () => {
    expect(shouldShowUpdateAvailable(['abc1234 fix: something'], true, true)).toBe(true);
  });

  test('false when the changelog is empty and reliable (genuinely no runner changes)', () => {
    expect(shouldShowUpdateAvailable([], true, true)).toBe(false);
  });

  test('true when the changelog is empty but unreliable (shallow-clone artifact)', () => {
    expect(shouldShowUpdateAvailable([], false, true)).toBe(true);
  });

  test('true when entries are present even if flagged unreliable', () => {
    expect(shouldShowUpdateAvailable(['abc1234 fix: something'], false, true)).toBe(true);
  });
});
