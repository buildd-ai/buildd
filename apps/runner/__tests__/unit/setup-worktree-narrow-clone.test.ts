/**
 * setupWorktree in a cloud container's clone: depth 1, the workspace default
 * branch only (git-clone.ts). Every other `origin/<branch>` it needs (a
 * mission integration branch as the declared base, a resume branch, the task's
 * own pushed branch) is fetched on demand by name. A host runner's full clone
 * takes none of those fetches.
 *
 * Real git: a bare origin with more history than any depth used here
 * (fixtures/deep-origin.ts). Deps are injected with the REAL child_process/fs,
 * recording the commands, so only sessionLog is captured.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as cp from 'child_process';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupWorktree, collectGitStats, __setGitOpsDeps, __resetGitOpsDeps } from '../../src/git-operations';
import { CLOUD_BRANCH_FETCH_DEPTH, cloneRepo } from '../../src/git-clone';
import { git, makeDeepOrigin, remoteBranches } from '../fixtures/deep-origin';

let dir: string;
let origin: string;
let url: string;
let commands: string[];

const WORKER = 'w-narrow-12345678';

function cloudClone(): string {
  const path = join(dir, 'cloud');
  cloneRepo(url, path, { env: { BUILDD_EXECUTOR: 'cloud' }, branch: 'dev', log: () => {} });
  return path;
}
function hostClone(): string {
  const path = join(dir, 'host');
  cloneRepo(url, path, { env: {}, log: () => {} });
  return path;
}
const fetches = () => commands.filter(c => /^git '?fetch/.test(c));
const commitIn = (cwd: string, file: string) => {
  fs.writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', file);
};

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'narrow-wt-'));
  ({ origin, url } = makeDeepOrigin(dir));
  commands = [];
  const recordingExec = ((cmd: string, opts?: cp.ExecSyncOptions) => {
    commands.push(String(cmd));
    return cp.execSync(cmd, opts);
  }) as typeof cp.execSync;
  __setGitOpsDeps({
    execSync: recordingExec, execFile: cp.execFile, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync,
    appendFileSync: fs.appendFileSync, readFileSync: fs.readFileSync, rmSync: fs.rmSync,
    // No real install in a test worktree.
    readdirSync: fs.readdirSync,
    sessionLog: () => {},
  });
});
afterEach(() => {
  __resetGitOpsDeps();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cloud clone: bases and resume branches come in on demand', () => {
  test('a mission task: the integration branch (declared base) is fetched and the worktree is cut from it', async () => {
    const repo = cloudClone();
    expect(remoteBranches(repo)).toEqual(['dev']);
    const r = await setupWorktree(repo, 'buildd/task-1', 'dev', WORKER, { baseBranch: 'mission/x' });
    expect(r).not.toBeNull();
    expect(r!.base).toBe('origin/mission/x');
    expect(r!.fallback).toBeUndefined();
    expect(git(r!.path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'mission/x'));
    expect(fetches().some(c => c.includes('refs/heads/mission/x') && c.includes(`'--depth' '${CLOUD_BRANCH_FETCH_DEPTH}'`))).toBe(true);
    // Still shallow; only the one branch came in.
    expect(git(repo, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(remoteBranches(repo)).toEqual(['dev', 'mission/x']);

    // PR stats against the ref the worktree was cut from.
    commitIn(r!.path, 'task.txt');
    const stats = await collectGitStats(r!.path, WORKER, undefined, r!.base);
    expect(stats.commitCount).toBe(1);
    expect(stats.filesChanged).toBe(1);

    // A resumed container's clone has the default branch only: the base comes back on demand for the stats.
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/mission/x');
    const again = await collectGitStats(r!.path, WORKER, undefined, r!.base);
    expect(again.commitCount).toBe(1);
    expect(again.filesChanged).toBe(1);
    expect(remoteBranches(repo)).toEqual(['dev', 'mission/x']);
  });

  test('a declared base the remote does not have: falls back to the default branch (reason missing)', async () => {
    const repo = cloudClone();
    const r = await setupWorktree(repo, 'buildd/task-2', 'dev', WORKER, { baseBranch: 'mission/gone' });
    expect(r!.base).toBe('origin/dev');
    expect(r!.fallback).toEqual({ candidate: 'mission/gone', reason: 'missing' });
  });

  test('a resume: the prior attempt\'s pushed branch is fetched and checked out directly', async () => {
    // A prior attempt cut buildd/resume-1 from dev and pushed one commit.
    const seed = join(dir, 'seed');
    cp.execFileSync('git', ['clone', '-q', '--branch', 'dev', origin, seed], { stdio: 'pipe' });
    git(seed, 'checkout', '-q', '-b', 'buildd/resume-1');
    commitIn(seed, 'prior.txt');
    git(seed, 'push', '-q', 'origin', 'buildd/resume-1');

    const repo = cloudClone();
    const r = await setupWorktree(repo, 'buildd/resume-1', 'dev', WORKER, { resumeBranch: 'buildd/resume-1', baseBranch: 'dev' });
    expect(r!.base).toBe('origin/buildd/resume-1');
    expect(r!.branch).toBe('buildd/resume-1');
    expect(r!.fallback).toBeUndefined();
    expect(git(r!.path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'buildd/resume-1'));
  });

  test('a resume branch cut long before the shallow default tip: divergence is undecidable locally, so it resumes', async () => {
    // buildd/old shares no commit with the depth-1 clone of dev. Counting
    // origin/dev..origin/buildd/old there counts every fetched commit, which
    // would read as "diverged" and silently start a fresh branch instead.
    const repo = cloudClone();
    // Deeper than the 50-commit veto (an agent deepened it, or a merge widened the walk).
    git(repo, 'fetch', '-q', '--depth', '75', 'origin', '+refs/heads/buildd/old:refs/remotes/origin/buildd/old');
    expect(Number(git(repo, 'rev-list', '--count', 'origin/dev..origin/buildd/old'))).toBeGreaterThan(50);
    const r = await setupWorktree(repo, 'buildd/old', 'dev', WORKER, { resumeBranch: 'buildd/old', baseBranch: 'dev' });
    expect(r!.base).toBe('origin/buildd/old');
    expect(r!.fallback).toBeUndefined();
  });

  test('a resume branch that is gone cascades to the declared base, fetched on demand', async () => {
    const repo = cloudClone();
    const r = await setupWorktree(repo, 'buildd/task-3', 'dev', WORKER, { resumeBranch: 'buildd/never-pushed', baseBranch: 'mission/x' });
    expect(r!.base).toBe('origin/mission/x');
    expect(r!.fallback).toEqual({ candidate: 'buildd/never-pushed', reason: 'missing' });
  });

  test('a stale local copy of the task branch whose commits are on origin is checked against origin/<branch>, fetched on demand', async () => {
    // The task branch was pushed by a prior attempt; this clone has a local
    // copy of it (a park restore) but never fetched origin/<branch>. Without
    // the remote ref the local branch reads as unpushed and is renamed away.
    const seed = join(dir, 'seed');
    cp.execFileSync('git', ['clone', '-q', '--branch', 'dev', origin, seed], { stdio: 'pipe' });
    git(seed, 'checkout', '-q', '-b', 'buildd/task-4');
    commitIn(seed, 'pushed.txt');
    git(seed, 'push', '-q', 'origin', 'buildd/task-4');

    const repo = cloudClone();
    git(repo, 'fetch', '-q', '--depth', '5', 'origin', 'buildd/task-4');
    git(repo, 'branch', 'buildd/task-4', 'FETCH_HEAD');
    const r = await setupWorktree(repo, 'buildd/task-4', 'dev', WORKER, {});
    expect(r).not.toBeNull();
    expect(git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/buildd/task-4-orphan-*')).toBe('');
  });
});

describe('host clone: unchanged', () => {
  test('a mission task resolves origin/mission/x from the full clone, with no on-demand fetch', async () => {
    const repo = hostClone();
    const r = await setupWorktree(repo, 'buildd/task-1', 'main', WORKER, { baseBranch: 'mission/x' });
    expect(r!.base).toBe('origin/mission/x');
    expect(fetches()).toEqual(['git fetch origin']);
  });

  test('a declared base that does not exist falls back without any extra fetch', async () => {
    const repo = hostClone();
    const r = await setupWorktree(repo, 'buildd/task-2', 'main', WORKER, { baseBranch: 'mission/gone' });
    expect(r!.fallback).toEqual({ candidate: 'mission/gone', reason: 'missing' });
    expect(fetches()).toEqual(['git fetch origin']);
  });
});
