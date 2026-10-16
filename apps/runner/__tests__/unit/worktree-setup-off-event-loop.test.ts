/**
 * Starting and finishing a task never holds the runner's event loop on git.
 *
 * Follow-up to git-off-event-loop.test.ts (the repo scan and the sync tick).
 * Measured on a live runner after that shipped: each task start still froze
 * the loop for seconds while worktree setup ran `git fetch`, `git worktree
 * add`, `git status`, `git stash list`, the derived-file `git config` calls and
 * the cloud branch fetch synchronously. Here a fake `git` on PATH sleeps before
 * exec'ing the real one for exactly those commands, and a socket served from
 * this process is probed every few ms while the setup runs: the slowest answer
 * must still be quick.
 *
 * The baseline test runs one of the old sync calls under the same harness and
 * shows the probe waiting the full sleep, so this file can fail.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worktree-setup-off-event-loop.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

mock.module('../../src/session-logger', () => ({ sessionLog: mock(() => {}) }));

import { execFileSync, execSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupWorktree, collectGitStats, cleanupWorktree, removeWorktreeIfUnowned, warnOnPrimaryCloneDrift, __resetPrimaryCloneDriftWarnings } from '../../src/git-operations';
import { registerMergeDrivers, mergeBaseWithDerivedFiles } from '../../src/merge-drivers';
import { ensureRemoteBranchAsync } from '../../src/git-clone';
import { initTestWorkspace, cleanupTestWorkspace } from '../test-workspace';

const SLEEP_S = 1;
/** A loop that is free answers in a few ms; a sync git holds it for the whole sleep. */
const ANSWER_WITHIN_MS = 200;

const REAL_GIT = execSync('command -v git', { encoding: 'utf-8' }).trim();
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(
  ['HOME', 'BUILDD_HOME', 'BUILDD_EXECUTOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].map(k => [k, process.env[k]]),
);

let tmp: string;
let socketPath: string;
let server: ReturnType<typeof Bun.serve>;
let gitLog: string;

const realGit = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), `${msg}\n`);
  realGit(cwd, 'add', '-A');
  realGit(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
};

/** An origin with `dev`, and a full clone of it at `<name>` (path contains "slow"). */
function makeClone(name: string): { origin: string; clone: string } {
  const seed = join(tmp, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  realGit(seed, 'init', '-q', '-b', 'dev');
  commit(seed, 'a.ts', 'base');
  const origin = join(tmp, `${name}-origin.git`);
  realGit(tmp, 'clone', '-q', '--bare', seed, origin);
  const clone = join(tmp, name);
  realGit(tmp, 'clone', '-q', origin, clone);
  return { origin, clone };
}

/**
 * Probe the socket every few ms until `work` settles; the slowest answer is
 * how long the event loop was held at most.
 */
async function worstLatencyDuring<T>(work: () => Promise<T>): Promise<{ result: T; worstMs: number }> {
  let done = false;
  let worst = 0;
  const probe = (async () => {
    while (!done) {
      const t0 = performance.now();
      const res = await fetch('http://localhost/api/runner', { unix: socketPath } as RequestInit);
      await res.text();
      worst = Math.max(worst, performance.now() - t0);
      await new Promise(r => setTimeout(r, 10));
    }
  })();
  // Let the first probe go out before the work starts.
  await new Promise(r => setTimeout(r, 20));
  try {
    const result = await work();
    return { result, worstMs: worst };
  } finally {
    done = true;
    await probe;
  }
}

beforeAll(() => {
  tmp = initTestWorkspace();
  // Never the host's ~/.buildd: the session log and archive dirs live here.
  process.env.HOME = join(tmp, 'home');
  process.env.BUILDD_HOME = join(tmp, 'home', '.buildd');
  mkdirSync(process.env.BUILDD_HOME, { recursive: true });
  delete process.env.BUILDD_EXECUTOR;
  // The pre-merge commits; a temp HOME has no git identity.
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.com';
  const binDir = join(tmp, 'bin');
  mkdirSync(binDir);
  gitLog = join(tmp, 'git-calls.log');
  // In "slow" dirs, the commands caught on the live runner sleep first.
  writeFileSync(join(binDir, 'git'), [
    '#!/bin/sh',
    `echo "$PWD $*" >> "${gitLog}"`,
    `case "$PWD" in *slow*) case "$1" in fetch|worktree|status|stash|config|merge) sleep ${SLEEP_S};; esac;; esac`,
    `exec "${REAL_GIT}" "$@"`,
    '',
  ].join('\n'));
  chmodSync(join(binDir, 'git'), 0o755);
  socketPath = join(tmp, 'runner.sock');
  server = Bun.serve({ unix: socketPath, fetch: () => Response.json({ ok: true }) });
  process.env.PATH = `${binDir}:${ORIGINAL_PATH}`;
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  server?.stop(true);
  cleanupTestWorkspace();
});

const gitCalls = (): string[] => {
  try { return readFileSync(gitLog, 'utf-8').split('\n').filter(Boolean); } catch { return []; }
};

describe('baseline', () => {
  test('a sync git call under this harness holds the socket for the whole sleep (what this replaces)', async () => {
    const { clone } = makeClone('baseline-slow');
    let worst = 0;
    const t0 = performance.now();
    const pending = fetch('http://localhost/api/runner', { unix: socketPath } as RequestInit).then(r => r.text()).then(() => { worst = performance.now() - t0; });
    execSync('git stash list', { cwd: clone, encoding: 'utf-8' });
    await pending;
    console.log(`[latency] sync git (baseline): socket answered in ${worst.toFixed(1)}ms`);
    expect(worst).toBeGreaterThan(SLEEP_S * 1000 - 300);
  }, 15_000);
});

describe('task start', () => {
  test('setupWorktree (fetch, drift probe, worktree add, branch config) never holds the loop', async () => {
    const { clone } = makeClone('setup-slow');
    writeFileSync(gitLog, '');
    const { result, worstMs } = await worstLatencyDuring(() => setupWorktree(clone, 'buildd/abc12345-thing', 'dev', 'w-setup-1'));
    console.log(`[latency] setupWorktree: worst socket answer ${worstMs.toFixed(1)}ms`);
    expect(result).not.toBeNull();
    expect(result!.branch).toBe('buildd/abc12345-thing');
    expect(existsSync(join(result!.path, 'a.ts'))).toBe(true);
    // Same commands as before, now run async.
    const calls = gitCalls();
    expect(calls.some(l => l.endsWith(' fetch origin'))).toBe(true);
    expect(calls.some(l => l.includes(' stash list'))).toBe(true);
    expect(calls.some(l => l.includes(' worktree add -b buildd/abc12345-thing'))).toBe(true);
    expect(realGit(clone, 'config', 'branch.buildd/abc12345-thing.merge').trim()).toBe('refs/heads/buildd/abc12345-thing');
    expect(worstMs).toBeLessThan(ANSWER_WITHIN_MS);
  }, 60_000);

  test('the primary-clone drift probe still reads a dirty clone and stashes', async () => {
    __resetPrimaryCloneDriftWarnings();
    const { clone } = makeClone('drift-slow');
    writeFileSync(join(clone, 'a.ts'), 'dirty\n');
    const { result, worstMs } = await worstLatencyDuring(() => warnOnPrimaryCloneDrift(clone, 'dev', 'w-drift-1'));
    expect(result).toContain('PRIMARY CLONE DRIFT');
    expect(worstMs).toBeLessThan(ANSWER_WITHIN_MS);
  }, 30_000);

  test('derived-file merge drivers register and pre-merge a base without holding the loop', async () => {
    const { origin, clone } = makeClone('drivers-slow');
    // A base that moved on after the branch was cut.
    realGit(clone, 'checkout', '-q', '-b', 'feature');
    commit(clone, 'b.ts', 'feature work');
    const other = join(tmp, 'drivers-other');
    realGit(tmp, 'clone', '-q', origin, other);
    commit(other, 'c.ts', 'trunk moved');
    realGit(other, 'push', '-q', 'origin', 'dev');
    realGit(clone, 'fetch', '-q', 'origin');
    const rules = [{ glob: 'bun.lock', strategy: 'ours' as const, regenerate: 'true' }];
    const { result, worstMs } = await worstLatencyDuring(async () => {
      const plan = await registerMergeDrivers(clone, rules as never, { mergiraf: false });
      const merged = await mergeBaseWithDerivedFiles(clone, 'origin/dev', rules as never);
      return { plan, merged };
    });
    console.log(`[latency] merge drivers + pre-merge: worst socket answer ${worstMs.toFixed(1)}ms`);
    expect(realGit(clone, 'config', '--local', 'merge.buildd-derived-0.driver')).toContain('buildd-derived');
    expect(result.merged.error).toBeUndefined();
    expect(result.merged.status).toBe('merged');
    expect(existsSync(join(clone, 'c.ts'))).toBe(true);
    expect(worstMs).toBeLessThan(ANSWER_WITHIN_MS);
  }, 60_000);

  test('a narrow (cloud) clone fetches a branch on demand without holding the loop', async () => {
    const { origin } = makeClone('narrow-seed-slow');
    const seed = join(tmp, 'narrow-push');
    realGit(tmp, 'clone', '-q', origin, seed);
    realGit(seed, 'checkout', '-q', '-b', 'mission/x');
    commit(seed, 'm.ts', 'mission');
    realGit(seed, 'push', '-q', 'origin', 'mission/x');
    const narrow = join(tmp, 'narrow-slow');
    realGit(tmp, 'clone', '-q', '--single-branch', '--branch', 'dev', `file://${origin}`, narrow);
    const { result, worstMs } = await worstLatencyDuring(() => ensureRemoteBranchAsync(narrow, 'mission/x', { log: () => {} }));
    expect(result).toBe('fetched');
    expect(realGit(narrow, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/mission/x').trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(worstMs).toBeLessThan(ANSWER_WITHIN_MS);
  }, 30_000);
});

describe('task finish', () => {
  test('git stats and worktree removal never hold the loop', async () => {
    const { clone } = makeClone('finish-slow');
    const setup = await setupWorktree(clone, 'buildd/def67890-finish', 'dev', 'w-finish-1');
    expect(setup).not.toBeNull();
    commit(setup!.path, 'x.ts', 'work');
    writeFileSync(join(setup!.path, 'a.ts'), 'edited\n');
    const { result: stats, worstMs: statsMs } = await worstLatencyDuring(() => collectGitStats(setup!.path, 'w-finish-1', undefined, setup!.base));
    expect(stats.commitCount).toBe(1);
    expect(stats.dirtyWorktree).toBe(true);
    expect(statsMs).toBeLessThan(ANSWER_WITHIN_MS);

    const { worstMs: removeMs } = await worstLatencyDuring(() => removeWorktreeIfUnowned({
      repoPath: clone, worktreePath: setup!.path, workerId: 'w-finish-1', workers: [], archiveDir: join(tmp, 'archive'),
    }));
    expect(existsSync(setup!.path)).toBe(false);
    expect(removeMs).toBeLessThan(ANSWER_WITHIN_MS);

    const second = await setupWorktree(clone, 'buildd/def67890-again', 'dev', 'w-finish-2');
    const { worstMs: cleanupMs } = await worstLatencyDuring(() => cleanupWorktree(clone, second!.path, 'w-finish-2'));
    expect(existsSync(second!.path)).toBe(false);
    expect(cleanupMs).toBeLessThan(ANSWER_WITHIN_MS);
  }, 90_000);
});
