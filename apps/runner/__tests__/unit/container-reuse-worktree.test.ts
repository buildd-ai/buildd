/**
 * Container reuse end to end on real git: a task runs in a cloud clone
 * (depth 1, one branch: git-clone.ts), plants what it can for the next task,
 * the container is reset (container-reset.ts), and the next task's clone is
 * grown from the kept packs and handed to setupWorktree.
 *
 * The next task must run in the clone (a reused clone is as good as a fresh one
 * for setupWorktree), must not pay the warm restore (the kept packs are its
 * repo), and must see nothing the previous task planted: no ~/PLANTED_* file,
 * no global git identity, no global or repo hooks.
 *
 * HOME is the test's own. Bun does not pass process.env changes on to child
 * processes, so every git this file runs itself gets the env explicitly
 * (gitEnv): planting, and checking what the next task sees, never touch the
 * developer's real HOME. ensureIsolatedClone reads process.env directly.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as cp from 'child_process';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KEEP_DIRNAME, resetContainer, type ResetPaths } from '../../src/container-reset';
import { __resetGitOpsDeps, __setGitOpsDeps, setupWorktree, takeSetupWorktreeError } from '../../src/git-operations';
import { ensureIsolatedClone } from '../../src/workspace';
import type { CloneHooks } from '../../src/warm-repo';
import { makeDeepOrigin } from '../fixtures/deep-origin';

// Real git throughout: well under a second alone, slower under the full suite's concurrency.
setDefaultTimeout(15_000);

const WS = 'ws-reuse-1';
let dir: string;
let origin: string;
let url: string;
let paths: ResetPaths;
let marker: string;
let lines: string[];
let savedEnv: Record<string, string | undefined>;
let savedLog: typeof console.log;

/** The container's env for git: its HOME (so its global config applies), never the system config. */
function gitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: paths.home, GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.XDG_CONFIG_HOME;
  return env;
}
function git(cwd: string, ...args: string[]): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv() }).trim();
}
function gitStatus(cwd: string, ...args: string[]): number {
  return cp.spawnSync('git', args, { cwd, stdio: 'ignore', env: gitEnv() }).status ?? -1;
}

/** Records whether the warm restore was asked for; never restores (no snapshot store here). */
function hooks(): CloneHooks & { restores: number } {
  const h = {
    restores: 0,
    restore: () => { h.restores++; return false; },
    afterClone: () => {},
  };
  return h;
}

const clonePath = () => join(paths.isolationRoot, WS);

function acquire(h = hooks()) {
  const path = ensureIsolatedClone({ id: WS, repo: url, defaultBranch: 'dev' }, paths.isolationRoot, h);
  return { path, h };
}

function reset() {
  const r = resetContainer(paths, {
    listProcs: () => [],
    kill: () => {},
    selfPid: process.pid,
    uid: process.getuid!(),
    sleep: () => {},
    log: () => {},
  });
  expect(r.error).toBeUndefined();
  expect(r.ok).toBe(true);
  return r;
}

/** Everything a task can leave for the next one, from inside its worktree. */
function plant(worktree: string) {
  const home = paths.home;
  // Never plant outside the test's HOME.
  const origins = cp.spawnSync('git', ['config', '--global', '--show-origin', '--list'], { cwd: worktree, encoding: 'utf-8', env: gitEnv() }).stdout ?? '';
  expect(origins.split('\n').every(l => !l || l.startsWith(`file:${home}/`))).toBe(true);
  fs.writeFileSync(join(home, 'PLANTED_note'), 'from the previous task');
  git(worktree, 'config', '--global', 'user.name', 'Planted By Previous Task');
  git(worktree, 'config', '--global', 'user.email', 'planted@example.com');
  const hooksDir = join(home, 'planted-hooks');
  fs.mkdirSync(hooksDir);
  for (const hook of ['post-checkout', 'pre-commit', 'reference-transaction']) {
    fs.writeFileSync(join(hooksDir, hook), `#!/bin/sh\ntouch ${marker}\n`);
    fs.chmodSync(join(hooksDir, hook), 0o755);
  }
  git(worktree, 'config', '--global', 'core.hooksPath', hooksDir);
  // And in the clone itself: a hook and a local hooksPath.
  fs.writeFileSync(join(clonePath(), '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`);
  fs.chmodSync(join(clonePath(), '.git', 'hooks', 'post-checkout'), 0o755);
  git(clonePath(), 'config', '--local', 'core.hooksPath', hooksDir);
}

function assertNothingPlanted(worktree: string) {
  expect(fs.readdirSync(paths.home).filter(n => n.startsWith('PLANTED_'))).toEqual([]);
  expect(fs.existsSync(join(paths.home, 'planted-hooks'))).toBe(false);
  expect(fs.existsSync(join(paths.home, '.gitconfig'))).toBe(false);
  expect(gitStatus(worktree, 'config', '--global', 'user.name')).not.toBe(0);
  expect(gitStatus(worktree, 'config', 'core.hooksPath')).not.toBe(0);
  // Git in the new worktree runs nothing the previous task planted.
  fs.writeFileSync(join(worktree, 'review.txt'), 'review\n');
  git(worktree, 'add', 'review.txt');
  git(worktree, '-c', 'user.name=r', '-c', 'user.email=r@example.com', 'commit', '-qm', 'review');
  git(worktree, 'checkout', '-q', '-b', 'scratch');
  expect(fs.existsSync(marker)).toBe(false);
}

function commitAndPush(worktree: string, file: string, branch: string) {
  fs.writeFileSync(join(worktree, file), `${file}\n`);
  git(worktree, 'add', file);
  git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', file);
  git(worktree, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
}

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'reuse-wt-'));
  ({ origin, url } = makeDeepOrigin(dir));
  const home = join(dir, 'home');
  const builddHome = join(home, '.buildd');
  paths = {
    home,
    isolationRoot: join(builddHome, 'once-workspaces'),
    cacheDir: join(home, '.bun', 'install', 'cache'),
    skeletonDirs: [builddHome, join(home, 'work')],
    scratchDirs: [],
  };
  fs.mkdirSync(paths.isolationRoot, { recursive: true });
  fs.mkdirSync(join(home, 'work'), { recursive: true });
  marker = join(dir, 'planted-hook-ran');

  // Read in-process by keptDirForClone, cloneRepo and the phase lines.
  savedEnv = { HOME: process.env.HOME, BUILDD_EXECUTOR: process.env.BUILDD_EXECUTOR };
  process.env.HOME = home;
  process.env.BUILDD_EXECUTOR = 'cloud';
  lines = [];
  savedLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };

  __setGitOpsDeps({
    execSync: cp.execSync, execFile: cp.execFile, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync,
    appendFileSync: fs.appendFileSync, readFileSync: fs.readFileSync, rmSync: fs.rmSync,
    readdirSync: fs.readdirSync,
    sessionLog: () => {},
  });
});

afterEach(() => {
  console.log = savedLog;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetGitOpsDeps();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reset → next task: setupWorktree in the reused clone', () => {
  test('builder then reviewer then builder: each reused clone runs in place, from the kept packs, with nothing planted', async () => {
    // ── Task 1 (fresh container): cloud clone, builder checkout, push, plant ──
    const first = acquire();
    expect(first.h.restores).toBe(1);
    expect(git(first.path, 'rev-parse', '--is-shallow-repository')).toBe('true');
    const builder = await setupWorktree(first.path, 'buildd/aaaa1111-feature', 'dev', 'w-builder-11111111', {});
    expect(builder).not.toBeNull();
    expect(builder!.path).toBe(first.path);
    expect(fs.existsSync(join(first.path, '.buildd-worktrees'))).toBe(false);
    commitAndPush(builder!.path, 'feature.txt', 'buildd/aaaa1111-feature');
    plant(builder!.path);

    // ── Reset, then task 2: a reviewer of the builder's branch ──
    reset();
    lines = [];
    const second = acquire();
    // The kept packs are the repo: no warm restore, no clone.
    expect(second.h.restores).toBe(0);
    expect(lines).toContain('BUILDD_REPO_SOURCE=reuse');
    expect(lines.some(l => l.startsWith('BUILDD_PHASE=restore_reuse_start '))).toBe(true);
    expect(lines.some(l => l.startsWith('BUILDD_PHASE=restore_reuse_end '))).toBe(true);
    expect(lines.some(l => l.startsWith('BUILDD_PHASE=clone_start '))).toBe(false);
    // Shaped like a fresh cloud clone for setupWorktree.
    expect(git(second.path, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(git(second.path, 'remote', 'get-url', 'origin')).toBe(url);
    expect(git(second.path, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/dev');
    expect(git(second.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('dev');
    expect(git(second.path, 'rev-parse', '--abbrev-ref', 'dev@{upstream}')).toBe('origin/dev');
    expect(git(second.path, 'rev-parse', 'origin/dev')).toBe(git(origin, 'rev-parse', 'dev'));
    expect(git(second.path, 'status', '--porcelain')).toBe('');
    expect(git(second.path, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/dev');

    const reviewer = await setupWorktree(second.path, 'buildd/bbbb2222-review', 'dev', 'w-review-22222222', {
      resumeBranch: 'buildd/aaaa1111-feature', baseBranch: 'buildd/aaaa1111-feature',
    });
    expect(reviewer).not.toBeNull();
    expect(reviewer!.path).toBe(second.path);
    expect(fs.existsSync(join(second.path, '.buildd-worktrees'))).toBe(false);
    expect(git(reviewer!.path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'buildd/aaaa1111-feature'));
    assertNothingPlanted(reviewer!.path);
    plant(reviewer!.path);

    // ── Reset again (a clone that was itself seeded), then task 3: a builder ──
    reset();
    lines = [];
    const third = acquire();
    expect(third.h.restores).toBe(0);
    expect(lines).toContain('BUILDD_REPO_SOURCE=reuse');
    const next = await setupWorktree(third.path, 'buildd/cccc3333-next', 'dev', 'w-next-33333333', { baseBranch: 'mission/x' });
    expect(next).not.toBeNull();
    expect(next!.path).toBe(third.path);
    expect(fs.existsSync(join(third.path, '.buildd-worktrees'))).toBe(false);
    expect(next!.base).toBe('origin/mission/x');
    assertNothingPlanted(next!.path);
  }, 60_000);

  test('origin moved on between the tasks: the next worktree is cut from the new tip', async () => {
    const first = acquire();
    expect(await setupWorktree(first.path, 'buildd/aaaa1111-feature', 'dev', 'w-builder-11111111', {})).not.toBeNull();
    reset();
    // Someone merged to dev meanwhile.
    const other = join(dir, 'other');
    git(dir, 'clone', '-q', '--branch', 'dev', url, other);
    commitAndPush(other, 'merged.txt', 'dev');
    const second = acquire();
    const wt = await setupWorktree(second.path, 'buildd/bbbb2222-next', 'dev', 'w-next-22222222', {});
    expect(wt).not.toBeNull();
    expect(git(wt!.path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'dev'));
    expect(fs.existsSync(join(wt!.path, 'merged.txt'))).toBe(true);
  });

  test('a seed that cannot be used leaves nothing behind and the task restores or clones as usual', async () => {
    acquire();
    reset();
    // Corrupt every kept pack: index-pack refuses them.
    const packs = join(paths.home, KEEP_DIRNAME, 'git', WS, 'pack');
    for (const name of fs.readdirSync(packs)) {
      const p = join(packs, name);
      const bytes = fs.readFileSync(p);
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      fs.chmodSync(p, 0o644);
      fs.writeFileSync(p, bytes);
    }
    const second = acquire();
    expect(second.h.restores).toBe(1);
    expect(lines.some(l => l.startsWith('BUILDD_PHASE=clone_start '))).toBe(true);
    expect(await setupWorktree(second.path, 'buildd/bbbb2222-next', 'dev', 'w-next-22222222', {})).not.toBeNull();
  });
});

describe('the seed fetches only what origin added', () => {
  /** A tree big enough that a full depth-1 pack and an incremental one are far apart: 300 incompressible files. */
  function growOrigin(): string {
    const other = join(dir, 'grow');
    git(dir, 'clone', '-q', '--branch', 'dev', url, other);
    for (let i = 0; i < 300; i++) fs.writeFileSync(join(other, `big-${i}.bin`), cp.execFileSync('head', ['-c', '1024', '/dev/urandom']));
    git(other, 'add', '.');
    git(other, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'big tree');
    git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/dev');
    return other;
  }
  const metric = (name: string): number | null => {
    const l = [...lines].reverse().find(x => x.startsWith(`BUILDD_METRIC=${name} `));
    return l ? Number(l.split(' ')[1]) : null;
  };
  // The task's own fetch. Its detached `git maintenance --auto` would race
  // the reset here; in a container the reset kills it first.
  const fetchInTask = (repo: string) => git(repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'fetch', '-q', 'origin');
  const haveRefs = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname)', 'refs/buildd/');

  test('origin unchanged: no fetch at all, nothing transferred', () => {
    growOrigin();
    acquire();
    reset();
    lines = [];
    const second = acquire();
    expect(lines).toContain('BUILDD_REPO_SOURCE=reuse');
    expect(metric('reuse_fetch_skipped')).toBe(1);
    expect(metric('restore_reuse_bytes')).toBe(0);
    // Not the clone's size on disk: nothing was cloned.
    expect(metric('clone_bytes')).toBeNull();
    expect(git(second.path, 'rev-parse', 'origin/dev')).toBe(git(origin, 'rev-parse', 'dev'));
    expect(haveRefs(second.path)).toBe('');
    expect(git(second.path, 'fsck', '--connectivity-only', '--no-dangling')).toBe('');
  });

  test('origin moved: only the new objects come, not the whole tree', () => {
    const other = growOrigin();
    acquire();
    reset();
    commitAndPush(other, 'moved.txt', 'dev');
    lines = [];
    const second = acquire();
    expect(metric('reuse_fetch_skipped')).toBe(0);
    const bytes = metric('restore_reuse_bytes');
    expect(bytes).not.toBeNull();
    // The 300 KiB tree stays; one commit, one tree and one blob come.
    expect(bytes!).toBeLessThan(64 * 1024);
    expect(git(second.path, 'rev-parse', 'origin/dev')).toBe(git(origin, 'rev-parse', 'dev'));
    expect(fs.existsSync(join(second.path, 'moved.txt'))).toBe(true);
    expect(haveRefs(second.path)).toBe('');
  });

  test("origin's tip was a loose object the reset dropped: the kept commits still negotiate", () => {
    const other = growOrigin();
    const first = acquire();
    // During the first task origin moves, and the task's own small fetch
    // lands loose (under fetch.unpackLimit): the tip the clone's refs name is
    // not in any pack the reset keeps.
    commitAndPush(other, 'during.txt', 'dev');
    fetchInTask(first.path);
    expect(git(first.path, 'count-objects')).not.toMatch(/^0 objects/);
    reset();
    lines = [];
    const second = acquire();
    const bytes = metric('restore_reuse_bytes');
    expect(bytes).not.toBeNull();
    expect(bytes!).toBeLessThan(64 * 1024);
    expect(git(second.path, 'rev-parse', 'origin/dev')).toBe(git(origin, 'rev-parse', 'dev'));
    expect(git(second.path, 'fsck', '--connectivity-only', '--no-dangling')).toBe('');
  });

  test('a kept commit whose objects are gone is never offered: the seed stays complete', () => {
    const other = growOrigin();
    const first = acquire();
    // Small fetch (loose, dropped by the reset), then a big one whose pack
    // leans on it: the big pack's commit names a parent and trees that are
    // not kept. Offering it as a have would leave the seed incomplete.
    commitAndPush(other, 'small.txt', 'dev');
    fetchInTask(first.path);
    for (let i = 0; i < 150; i++) fs.writeFileSync(join(other, `more-${i}.txt`), `${i}\n`);
    git(other, 'add', '.');
    git(other, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'more');
    git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/dev');
    fetchInTask(first.path);
    reset();
    lines = [];
    const second = acquire();
    expect(lines).toContain('BUILDD_REPO_SOURCE=reuse');
    expect(git(second.path, 'rev-parse', 'origin/dev')).toBe(git(origin, 'rev-parse', 'dev'));
    expect(git(second.path, 'fsck', '--connectivity-only', '--no-dangling')).toBe('');
    expect(git(second.path, 'status', '--porcelain')).toBe('');
  });
});

describe('a worktree that cannot be set up says why', () => {
  test('git\'s reason is kept for the start failure, once', async () => {
    const first = acquire();
    process.env.BUILDD_EXECUTOR = 'host';
    // Something sits where the host worktrees go.
    fs.writeFileSync(join(first.path, '.buildd-worktrees'), 'not a directory');
    const r = await setupWorktree(first.path, 'buildd/dddd4444-x', 'dev', 'w-fail-44444444', {});
    expect(r).toBeNull();
    const why = takeSetupWorktreeError('w-fail-44444444');
    expect(why).toContain('.buildd-worktrees');
    expect(takeSetupWorktreeError('w-fail-44444444')).toBeUndefined();
  });
});
