import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as cp from 'child_process';
import * as fs from 'fs';
const { execFileSync } = cp;
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { posixShell } from '../../src/posix-shell';
import { setupWorktree, cleanupWorktree, removeWorktreeIfUnowned, removeWorktreeIfUnownedSync, __setGitOpsDeps, __resetGitOpsDeps } from '../../src/git-operations';

const dirs: string[] = [];
const saved = process.env.BUILDD_EXECUTOR;
const commands: string[] = [];
beforeEach(() => {
  commands.length = 0;
  __setGitOpsDeps({ ...fs, execFile: cp.execFile, sessionLog: () => {},
    execSync: ((command: string, opts: any) => {
      commands.push(command);
      // The runner's own exec is a POSIX sh on Windows too; cmd.exe keeps single quotes.
      return cp.execSync(command, process.platform === 'win32' ? { ...opts, shell: posixShell() } : opts);
    }) as typeof cp.execSync,
  });
});

afterEach(() => {
  __resetGitOpsDeps();
  if (saved === undefined) delete process.env.BUILDD_EXECUTOR;
  else process.env.BUILDD_EXECUTOR = saved;
  // Windows can hold a just-exited git process's handles for a moment (EBUSY); retry the teardown.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function commit(cwd: string, message: string) {
  git(cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'in-clone-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'dev');
  // No background gc/maintenance process lingering in the temp dir after a test.
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'maintenance.auto', 'false');
  writeFileSync(join(dir, 'file'), 'base');
  git(dir, 'add', '.');
  commit(dir, 'base');
  const clone = join(dir, 'clone');
  git(dir, 'clone', '-q', '--single-branch', '--branch', 'dev', dir, clone);
  git(clone, 'config', 'gc.auto', '0');
  git(clone, 'config', 'maintenance.auto', 'false');
  return clone;
}

for (const mode of ['cloud', 'host']) {
  test(`${mode} fresh session uses the appropriate checkout`, async () => {
    process.env.BUILDD_EXECUTOR = mode;
    const clone = repo();
    const result = await setupWorktree(clone, 'buildd/fresh', 'dev', 'fresh');
    expect(result).not.toBeNull();
    expect(result!.path === clone).toBe(mode === 'cloud');
    expect(existsSync(join(clone, '.buildd-worktrees'))).toBe(mode !== 'cloud');
    expect(git(result!.path, 'branch', '--show-current')).toBe('buildd/fresh');
    expect(result!.base).toBe('origin/dev');
    expect(commands.includes('git fetch origin')).toBe(mode !== 'cloud');
  });
}

test('cloud resumes a local branch even when the clone already holds it', async () => {
  process.env.BUILDD_EXECUTOR = 'cloud';
  const clone = repo();
  git(clone, 'checkout', '-qb', 'buildd/resume');
  writeFileSync(join(clone, 'extra'), 'resume');
  git(clone, 'add', '.');
  commit(clone, 'resume');
  const sha = git(clone, 'rev-parse', 'HEAD');
  const result = await setupWorktree(clone, 'buildd/new', 'dev', 'resume', { resumeBranch: 'buildd/resume' });
  expect(result!.path).toBe(clone);
  expect(result!.branch).toBe('buildd/resume');
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(sha);
  expect(existsSync(join(clone, '.buildd-worktrees'))).toBe(false);
});

test('cloud resumes a branch fetched from the remote', async () => {
  process.env.BUILDD_EXECUTOR = 'cloud';
  const clone = repo();
  const origin = dirname(clone);
  git(origin, 'checkout', '-qb', 'buildd/resume');
  writeFileSync(join(origin, 'extra'), 'remote resume');
  git(origin, 'add', 'extra');
  commit(origin, 'remote resume');
  const sha = git(origin, 'rev-parse', 'HEAD');
  const result = await setupWorktree(clone, 'buildd/new', 'dev', 'resume', { resumeBranch: 'buildd/resume' });
  expect(result!.path).toBe(clone);
  expect(result!.branch).toBe('buildd/resume');
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(sha);
  expect(existsSync(join(clone, '.buildd-worktrees'))).toBe(false);
});

test('cloud rejects a diverged resume candidate and uses the default base', async () => {
  process.env.BUILDD_EXECUTOR = 'cloud';
  const clone = repo();
  const origin = dirname(clone);
  git(origin, 'checkout', '-qb', 'buildd/diverged');
  // One git process for all 51 commits: far fewer short-lived children holding handles on Windows.
  let stream = '';
  for (let i = 0; i < 51; i++) {
    stream += `commit refs/heads/buildd/diverged\ncommitter test <test@example.com> ${1700000000 + i} +0000\ndata <<EOM\ncandidate ${i}\nEOM\n${i === 0 ? 'from refs/heads/buildd/diverged^0\n' : ''}\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: origin, input: stream, stdio: ['pipe', 'pipe', 'pipe'] });
  git(origin, 'reset', '-q', '--hard', 'buildd/diverged');
  const result = await setupWorktree(clone, 'buildd/fresh', 'dev', 'diverged', { resumeBranch: 'buildd/diverged' });
  expect(result!.path).toBe(clone);
  expect(result!.branch).toBe('buildd/fresh');
  expect(result!.base).toBe('origin/dev');
  expect(result!.fallback).toEqual({ candidate: 'buildd/diverged', reason: 'diverged' });
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'origin/dev'));
  expect(existsSync(join(clone, '.buildd-worktrees'))).toBe(false);
});

test('failed cloud checkout preserves the clone and local changes', async () => {
  process.env.BUILDD_EXECUTOR = 'cloud';
  const clone = repo();
  const origin = dirname(clone);
  git(origin, 'checkout', '-qb', 'buildd/remote');
  writeFileSync(join(origin, 'file'), 'remote change');
  git(origin, 'add', 'file');
  commit(origin, 'remote change');
  writeFileSync(join(clone, 'file'), 'local change');
  const result = await setupWorktree(clone, 'buildd/new', 'dev', 'failed', { resumeBranch: 'buildd/remote' });
  expect(result).toBeNull();
  expect(existsSync(join(clone, '.git'))).toBe(true);
  expect(git(clone, 'diff', '--', 'file')).toContain('local change');
  expect(existsSync(join(clone, '.buildd-worktrees'))).toBe(false);
});

test('cleanup never removes the primary clone', async () => {
  const clone = repo();
  await cleanupWorktree(clone, clone, 'cleanup');
  expect(existsSync(join(clone, '.git'))).toBe(true);
  expect(await removeWorktreeIfUnowned({ repoPath: clone, worktreePath: clone, workerId: 'cleanup', workers: [] })).toEqual({ removed: false, reason: 'primary_clone' });
  removeWorktreeIfUnownedSync({ repoPath: clone, worktreePath: clone, workerId: 'cleanup', workers: [] });
  expect(existsSync(join(clone, '.git'))).toBe(true);
});

test('cloud preserves unpushed branch when its orphan name is already taken', async () => {
  process.env.BUILDD_EXECUTOR = 'cloud';
  const clone = repo();
  // Origin holds the branch at base, so the on-demand fetch of it succeeds and
  // git waits for its upload-pack. Fetching a missing ref dies without waiting,
  // and on Windows that upload-pack (cwd: the origin, i.e. the temp root) can
  // still hold the directory when teardown removes it (EBUSY).
  git(dirname(clone), 'branch', 'buildd/fresh');
  git(clone, 'checkout', '-qb', 'buildd/fresh');
  writeFileSync(join(clone, 'extra'), 'unpushed');
  git(clone, 'add', '.');
  commit(clone, 'unpushed');
  const sha = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'branch', 'buildd/fresh-orphan-collisio', 'origin/dev');
  const result = await setupWorktree(clone, 'buildd/fresh', 'dev', 'collision');
  expect(result).toBeNull();
  expect(git(clone, 'rev-parse', 'buildd/fresh')).toBe(sha);
  expect(git(clone, 'rev-parse', 'origin/buildd/fresh')).toBe(git(clone, 'rev-parse', 'origin/dev'));
  expect(existsSync(join(clone, '.git'))).toBe(true);
});
