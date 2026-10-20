/**
 * doctor on a Windows runner.
 *
 * The worktree sweep removed finished task worktrees with
 * `git worktree remove --force "<path>" 2>/dev/null`, falling back to
 * `rm -rf`. Through cmd.exe both fail (`/dev/null` is no path there, and
 * there is no `rm`), so a Windows runner never reclaimed a worktree. The
 * removal is now argv git plus fs.rmSync, on every platform.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/doctor-windows.test.ts
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const injectedHome = process.env.BUILDD_HOME;
const doctorHome = mkdtempSync(join(tmpdir(), 'buildd-home-doctor-win-'));
process.env.BUILDD_HOME = doctorHome;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { removeWorktreeDir, defaultRunnerLogPath, tailLines } = require('../../src/doctor');

const scratch = mkdtempSync(join(tmpdir(), 'doctor-win-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(doctorHome, { recursive: true, force: true });
  if (injectedHome === undefined) delete process.env.BUILDD_HOME;
  else process.env.BUILDD_HOME = injectedHome;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('removeWorktreeDir', () => {
  test('removes a git worktree and its admin entry', () => {
    const repo = join(scratch, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const wt = join(scratch, 'wt-task');
    git(repo, 'worktree', 'add', '-q', '-b', 'buildd/task', wt);
    writeFileSync(join(wt, 'dirty.txt'), 'uncommitted');

    removeWorktreeDir(repo, wt);

    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('wt-task');
  });

  test('falls back to deleting a directory git does not know as a worktree', () => {
    const stray = join(scratch, 'stray');
    mkdirSync(join(stray, 'nested'), { recursive: true });
    writeFileSync(join(stray, 'nested', 'f.txt'), 'x');

    removeWorktreeDir(scratch, stray);

    expect(existsSync(stray)).toBe(false);
  });
});

describe('defaultRunnerLogPath', () => {
  test('POSIX keeps /tmp/buildd.log', () => {
    expect(defaultRunnerLogPath('linux', 'C:/ignored')).toBe('/tmp/buildd.log');
    expect(defaultRunnerLogPath('darwin', '/var/folders/x')).toBe('/tmp/buildd.log');
  });

  test('Windows uses the OS temp dir, not C:\\tmp', () => {
    expect(defaultRunnerLogPath('win32', 'C:/Users/a/AppData/Local/Temp')).toBe(join('C:/Users/a/AppData/Local/Temp', 'buildd.log'));
  });
});

describe('tailLines', () => {
  test('the last N lines, as `tail -N` prints them', () => {
    const f = join(scratch, 'log.txt');
    writeFileSync(f, Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const tail = tailLines(f, 50).split('\n').filter(Boolean);
    expect(tail.length).toBe(50);
    expect(tail[0]).toBe('line 31');
    expect(tail[49]).toBe('line 80');
  });
});
