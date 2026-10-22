/**
 * Async git must not let two claims write one clone's `.git` at once, a timed
 * out git must be gone (with its locks) before the caller moves on, and a
 * worktree is never removed from under a worker that took it during an await.
 *
 * Follow-up review notes on PR #4922 (task c3a4ca51):
 *  1. Sync git serialized worktree setup per clone by accident. Async, two
 *     setups in one clone interleave `git config` / `worktree add` / `branch`
 *     writes and collide on config.lock / packed-refs.lock, silently skipping
 *     core.hooksPath, a merge driver or a branch upstream, or failing setup.
 *  2. A timeout resolved the moment it sent SIGKILL. SIGKILL leaves git's
 *     index.lock behind, and the caller's next git (the merge abort) fails.
 *  3. removeWorktreeIfUnowned checked ownership, then awaited (archive, the
 *     unpushed probe): another worker could take the path in between.
 *
 * The fake git here holds an exclusive lock directory for every command that
 * writes the shared `.git`, sleeps inside it, and fails (like git on a held
 * config.lock) when it is already held. Without the runner's lock, two
 * concurrent setups collide; with it, none do.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/repo-write-lock.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

mock.module('../../src/session-logger', () => ({ sessionLog: mock(() => {}) }));

import { execFileSync, execSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupWorktree, releaseWorktreeReservation, removeWorktreeIfUnowned, __setGitOpsDeps, __resetGitOpsDeps } from '../../src/git-operations';
import { registerMergeDrivers } from '../../src/merge-drivers';
import { gitRunAsync, KILL_GRACE_MS } from '../../src/git-async';
import { gitCommonDirKey } from '../../src/repo-lock';
import { initTestWorkspace, cleanupTestWorkspace } from '../test-workspace';

// The fake git below is a `#!/bin/sh` script found on PATH, which Windows cannot
// exec: there the shim is not installed and the tests that need it are skipped.
const IS_WIN = process.platform === 'win32';
const REAL_GIT = IS_WIN ? 'git' : execSync('command -v git', { encoding: 'utf-8' }).trim();
const KEYS = ['PATH', 'BUILDD_EXECUTOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const ORIGINAL: Record<string, string | undefined> = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));

let tmp: string;
let binDir: string;
let collisions: string;

const realGit = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (cwd: string, file: string, body: string, msg: string) => {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), body);
  realGit(cwd, 'add', '-A');
  realGit(cwd, 'commit', '-q', '-m', msg);
};

beforeAll(() => {
  tmp = initTestWorkspace();
  delete process.env.BUILDD_EXECUTOR;
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.com';
  binDir = join(tmp, 'bin');
  mkdirSync(binDir);
  collisions = join(tmp, 'collisions.log');
  writeFileSync(collisions, '');
  if (IS_WIN) return;
  const lockDir = join(tmp, 'shared-git-write.lock');
  // Writers of the shared .git hold one exclusive lock while they run (and
  // sleep inside it). A second writer that finds it held fails, as git does on
  // a held config.lock, and records the collision.
  writeFileSync(join(binDir, 'git'), [
    '#!/bin/sh',
    'case "$1" in',
    '  config|worktree|branch|fetch)',
    `    if ! mkdir "${lockDir}" 2>/dev/null; then echo "$PWD $*" >> "${collisions}"; echo "error: could not lock config file" >&2; exit 255; fi`,
    '    sleep 0.15',
    `    "${REAL_GIT}" "$@"; rc=$?`,
    `    rmdir "${lockDir}"`,
    '    exit $rc;;',
    'esac',
    `exec "${REAL_GIT}" "$@"`,
    '',
  ].join('\n'));
  chmodSync(join(binDir, 'git'), 0o755);
  process.env.PATH = `${binDir}:${ORIGINAL.PATH}`;
});

afterAll(() => {
  for (const k of KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  cleanupTestWorkspace();
});

/** An origin with `dev` (carrying .githooks), and a full clone of it. */
function makeClone(name: string): string {
  const seed = join(tmp, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  realGit(seed, 'init', '-q', '-b', 'dev');
  commit(seed, '.githooks/pre-commit', '#!/bin/sh\nexit 0\n', 'hooks');
  commit(seed, 'a.ts', 'a\n', 'base');
  const origin = join(tmp, `${name}-origin.git`);
  realGit(tmp, 'clone', '-q', '--bare', seed, origin);
  const clone = join(tmp, name);
  realGit(tmp, 'clone', '-q', origin, clone);
  return clone;
}

describe('one writer per clone', () => {
  test('a worktree and its primary clone share one lock key', async () => {
    const clone = makeClone('key');
    realGit(clone, 'worktree', 'add', '-q', '-b', 'side', join(clone, '.buildd-worktrees', 'side'), 'origin/dev');
    expect(gitCommonDirKey(join(clone, '.buildd-worktrees', 'side'))).toBe(gitCommonDirKey(clone));
  });

  test('a --separate-git-dir main clone and its worktrees share one lock key', () => {
    const repo = join(tmp, 'sep-main');
    const gitDir = join(tmp, 'sep-gitdir');
    mkdirSync(repo);
    realGit(repo, 'init', '-q', '-b', 'dev', `--separate-git-dir=${gitDir}`);
    commit(repo, 'a.ts', 'x', 'base');
    const wt = join(repo, '.buildd-worktrees', 'side');
    realGit(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    expect(gitCommonDirKey(wt)).toBe(gitCommonDirKey(repo));
  });

  test.skipIf(IS_WIN)('two concurrent setups in one clone never overlap their writes, and both are fully configured', async () => {
    const clone = makeClone('concurrent');
    writeFileSync(collisions, '');
    const rules = [{ glob: 'bun.lock', strategy: 'theirs' as const, regenerate: 'true' }];
    const start = async (branch: string, id: string) => {
      const r = await setupWorktree(clone, branch, 'dev', id);
      if (!r) return null;
      await registerMergeDrivers(r.path, rules as never, { mergiraf: false });
      return r;
    };
    const [a, b] = await Promise.all([
      start('buildd/aaaa1111-one', 'w-aaaa1111'),
      start('buildd/bbbb2222-two', 'w-bbbb2222'),
    ]);
    expect(readFileSync(collisions, 'utf-8')).toBe('');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    for (const r of [a!, b!]) {
      expect(realGit(r.path, 'config', 'core.hooksPath').trim()).toBe('.githooks');
      expect(realGit(clone, 'config', `branch.${r.branch}.merge`).trim()).toBe(`refs/heads/${r.branch}`);
      expect(realGit(r.path, 'config', '--local', 'merge.buildd-derived-0.driver')).toContain('buildd-derived');
      expect(existsSync(join(r.path, 'a.ts'))).toBe(true);
    }
  }, 60_000);
});

describe('a timed-out git has exited, locks dropped, before the call returns', () => {
  // Windows has no SIGTERM: the tree is force-killed, git never drops index.lock,
  // and the runner removes the lock the killed git left instead.
  test('a merge killed at its timeout leaves no index.lock', async () => {
    const repo = join(tmp, 'lock-merge');
    mkdirSync(repo);
    realGit(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'f.lock', 'base\n', 'base');
    realGit(repo, 'checkout', '-q', '-b', 'feat');
    commit(repo, 'f.lock', 'feat\n', 'feat');
    realGit(repo, 'checkout', '-q', 'main');
    commit(repo, 'f.lock', 'main\n', 'main');
    realGit(repo, 'checkout', '-q', 'feat');
    // A driver that outlives the timeout, while git holds index.lock.
    realGit(repo, 'config', 'merge.slow.driver', 'sleep 30; cp %B %A');
    writeFileSync(join(repo, '.git', 'info', 'attributes'), 'f.lock merge=slow\n');
    const r = await gitRunAsync(['merge', '--no-edit', 'main'], { cwd: repo, timeoutMs: 700 });
    expect(r.timedOut).toBe(true);
    expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
    // The caller's next git (the abort) works.
    expect(() => realGit(repo, 'status', '--porcelain')).not.toThrow();
  }, 20_000);

  // A shell trap on SIGTERM, from a shim git: neither exists on Windows.
  test.skipIf(IS_WIN)('a child that ignores SIGTERM is SIGKILLed after the grace, and only then does the call settle', async () => {
    const dir = join(tmp, 'stubborn');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const pidFile = join(dir, 'pid');
    writeFileSync(join(dir, 'bin', 'git'), `#!/bin/sh\ntrap "" TERM\necho $$ > "${pidFile}"\nsleep 30\n`);
    chmodSync(join(dir, 'bin', 'git'), 0o755);
    const t0 = performance.now();
    // Long enough for the shell to install its trap even on a loaded host.
    const r = await gitRunAsync(['status'], { cwd: dir, timeoutMs: 1000, env: { ...process.env, PATH: `${join(dir, 'bin')}:${ORIGINAL.PATH}` } });
    const ms = performance.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    expect(ms).toBeGreaterThan(1000 + KILL_GRACE_MS - 300);
    expect(ms).toBeLessThan(1000 + KILL_GRACE_MS + 2500);
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }, 20_000);
});

describe('removeWorktreeIfUnowned re-checks ownership after its last await', () => {
  afterAll(() => __resetGitOpsDeps());

  test('a worker that takes the path while the archive runs keeps it', async () => {
    const REPO = '/repo';
    const WT = '/repo/.buildd-worktrees/buildd_0000abcd-fix-thing';
    const commands: string[] = [];
    const workers = new Map<string, { worktreePath?: string; status: string }>();
    __setGitOpsDeps({
      execSync: ((cmd: string) => { commands.push(cmd); return ''; }) as never,
      execFile: (() => {}) as never,
      existsSync: (() => true) as never,
      mkdirSync: (() => {}) as never,
      appendFileSync: (() => {}) as never,
      readFileSync: (() => '') as never,
      rmSync: (() => { commands.push('rmSync'); }) as never,
      sessionLog: () => {},
      // During the archive another worker starts in this path.
      archive: async () => {
        await new Promise(r => setTimeout(r, 10));
        workers.set('worker-b', { worktreePath: WT, status: 'working' });
        return { archived: false };
      },
    });
    const out = await removeWorktreeIfUnowned({ repoPath: REPO, worktreePath: WT, workerId: 'worker-a', workers });
    expect(out).toEqual({ removed: false, reason: 'owned_by_live_worker' });
    expect(commands.some(c => c.includes('worktree remove'))).toBe(false);
    expect(commands).not.toContain('rmSync');
  });
});

describe('a path setup just created is protected until its worker records it', () => {
  test('a teardown that passes the lock after setup released it does not remove the new worktree', async () => {
    const clone = makeClone('reserved');
    const r = await setupWorktree(clone, 'buildd/cccc3333-keep', 'dev', 'w-cccc3333');
    expect(r).not.toBeNull();
    // Setup has released the lock; workers.ts has not recorded the path yet.
    const out = await removeWorktreeIfUnowned({
      repoPath: clone, worktreePath: r!.path, workerId: 'w-old', workers: new Map(),
    });
    expect(out).toEqual({ removed: false, reason: 'owned_by_live_worker' });
    expect(existsSync(r!.path)).toBe(true);
    // Once recorded (reservation dropped) the workers map is the source of truth.
    releaseWorktreeReservation('w-cccc3333');
    const after = await removeWorktreeIfUnowned({
      repoPath: clone, worktreePath: r!.path, workerId: 'w-old', workers: new Map(),
    });
    expect(after).toEqual({ removed: true });
  }, 30_000);
});
