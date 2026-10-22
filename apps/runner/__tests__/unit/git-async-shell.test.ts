/**
 * gitShellAsync runs the runner's sh command lines on every host it supports.
 *
 * git-operations builds strings like `git merge-base HEAD x 2>/dev/null` and
 * awaits them through gitShellAsync. On Windows that used to spawn `/bin/sh`,
 * which does not exist, so every worktree setup failed with ENOENT; it now goes
 * through posixShell() (Git for Windows' sh.exe there, /bin/sh elsewhere).
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitAsyncError, gitShellAsync, indexLockPath } from '../../src/git-async';

const dir = mkdtempSync(join(tmpdir(), 'git-async-shell-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('gitShellAsync', () => {
  test('runs a git command line with sh redirects and ||', async () => {
    const out = await gitShellAsync('git rev-parse --is-inside-work-tree 2>/dev/null || echo "outside $(echo repo)"', { cwd: dir, timeoutMs: 10_000 });
    expect(out.trim()).toBe('outside repo');
  });

  test('a failing command rejects like execSync', async () => {
    const err = await gitShellAsync('git rev-parse HEAD', { cwd: dir, timeoutMs: 10_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(GitAsyncError);
    expect((err as GitAsyncError).message.split('\n')[0]).toBe('Command failed: git rev-parse HEAD');
    expect((err as GitAsyncError).exitCode).not.toBe(0);
  });

  test('a timeout kills the shell and the command under it, and settles', async () => {
    const started = Date.now();
    // `sleep` under sh keeps the pipes open: if only the sh wrapper died, the
    // call would settle only after the sleep (or the kill-wait backstop).
    const err = await gitShellAsync('sleep 20; echo late', { cwd: dir, timeoutMs: 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(GitAsyncError);
    expect((err as GitAsyncError).timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

// Windows has no SIGTERM: a timed-out git is force-killed and never drops its
// index.lock, so the caller's next git (the merge abort) failed on it.
describe('index.lock after a timeout kill', () => {
  const repo = join(dir, 'lock-repo');
  const lock = join(repo, '.git', 'index.lock');
  mkdirSync(join(repo, '.git'), { recursive: true });

  test('indexLockPath finds the lock of a clone and of a linked worktree', () => {
    expect(indexLockPath(join(repo, 'sub', 'dir'))).toBe(lock);
    const wt = join(dir, 'wt');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
    expect(indexLockPath(wt)).toBe(join(repo, '.git', 'worktrees', 'wt', 'index.lock'));
    writeFileSync(join(wt, '.git'), 'gitdir: ../lock-repo/.git/worktrees/wt\n');
    expect(indexLockPath(wt)).toBe(join(repo, '.git', 'worktrees', 'wt', 'index.lock'));
  });

  test.skipIf(process.platform !== 'win32')('a lock the killed command created is removed before the call settles', async () => {
    rmSync(lock, { force: true });
    const err = await gitShellAsync('touch .git/index.lock; sleep 20', { cwd: repo, timeoutMs: 700 }).catch((e) => e);
    expect((err as GitAsyncError).timedOut).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test('a lock that was already there (another git’s) is left alone', async () => {
    writeFileSync(lock, '');
    const err = await gitShellAsync('sleep 20', { cwd: repo, timeoutMs: 300 }).catch((e) => e);
    expect((err as GitAsyncError).timedOut).toBe(true);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { force: true });
  });
});
