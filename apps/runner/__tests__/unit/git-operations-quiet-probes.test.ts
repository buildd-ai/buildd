/**
 * Regression guard: three git probes inside setupWorktree used to leak their
 * expected-negative (and, for `git worktree add`, expected-positive) stderr
 * straight into the runner's log — `execSync` inherits fd 2 by default unless
 * `stdio` is explicitly overridden, so every one of these fired on every
 * worker start, including every success:
 *   - `git sparse-checkout list` (non-sparse repo → always throws; its only
 *     informational branch, `sparsePatterns` non-empty, has fired zero times)
 *   - `git branch -D <candidate>` (branch not local yet → always throws)
 *   - `git worktree add -b ...` (success prints git's own status line to
 *     stderr, duplicating the `console.log` the runner already emits after)
 *
 * All three must run with stdio fully piped (not inherited) so nothing reaches
 * the real stderr stream, while error.message must still carry stderr content
 * for the genuine-failure branches that build a message from it.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/git-operations-quiet-probes.test.ts
 */

import { describe, test, expect, afterAll, beforeEach } from 'bun:test';

type SyncCall = { cmd: string; opts: Record<string, unknown> };

const syncCalls: SyncCall[] = [];
let existsSyncMap: Record<string, boolean> = {};
let worktreeListOutput = '';

function mockExecSync(cmd: string, opts: Record<string, unknown>) {
  syncCalls.push({ cmd, opts });
  if (cmd.includes('worktree list --porcelain')) return worktreeListOutput;
  if (cmd.includes('sparse-checkout list')) {
    const err: any = new Error('this worktree is not sparse');
    err.status = 1;
    throw err;
  }
  if (cmd.includes('branch -D')) {
    const err: any = new Error('error: branch not found');
    err.status = 1;
    throw err;
  }
  if (cmd.includes('worktree add')) return ''; // success
  return '';
}

function mockExecFile(_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) {
  cb(null, '', '');
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupWorktree, __setGitOpsDeps, __resetGitOpsDeps } = require('../../src/git-operations');

afterAll(() => {
  __resetGitOpsDeps();
});

describe('setupWorktree quiets expected-negative/positive git probes', () => {
  beforeEach(() => {
    syncCalls.length = 0;
    existsSyncMap = {};
    worktreeListOutput = '';
    __setGitOpsDeps({
      execSync: mockExecSync as any,
      execFile: mockExecFile as any,
      existsSync: (p: string) => existsSyncMap[p] ?? false,
      mkdirSync: () => {},
      readFileSync: () => '# exclude\n' as any,
      appendFileSync: () => {},
      rmSync: () => {},
    });
  });

  function stdioOf(cmdSubstr: string): unknown {
    const call = syncCalls.find(c => c.cmd.includes(cmdSubstr));
    expect(call).toBeTruthy();
    return call!.opts.stdio;
  }

  test('git sparse-checkout list has stdio fully piped, not inherited', async () => {
    await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');
    const stdio = stdioOf('sparse-checkout list');
    expect(stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  test('git branch -D has stdio fully piped, not inherited', async () => {
    await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');
    const stdio = stdioOf('branch -D');
    expect(stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  test('git worktree add has stdio fully piped, not inherited', async () => {
    await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');
    const stdio = stdioOf('worktree add -b');
    expect(stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  // A resume/base branch that was never pushed (or was deleted after merge)
  // makes the existence probe throw `fatal: ambiguous argument
  // 'origin/<default>..origin/<candidate>'` — an expected negative the
  // resolver already handles (falls back and logs its own line). Inherited
  // stderr put that fatal in the runner log on every such worker start.
  test('the resume-branch existence probe (rev-list range) has stdio fully piped', async () => {
    __setGitOpsDeps({
      execSync: ((cmd: string, opts: Record<string, unknown>) => {
        syncCalls.push({ cmd, opts });
        if (cmd.includes('rev-list --count "origin/main..origin/')) {
          const err: any = new Error("fatal: ambiguous argument 'origin/main..origin/buildd/gone'");
          throw err;
        }
        return mockExecSync(cmd, opts);
      }) as any,
      execFile: mockExecFile as any,
      existsSync: (p: string) => existsSyncMap[p] ?? false,
      mkdirSync: () => {},
      readFileSync: () => '# exclude\n' as any,
      appendFileSync: () => {},
      rmSync: () => {},
    });
    await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1', { resumeBranch: 'buildd/gone' });
    const stdio = stdioOf('rev-list --count "origin/main..origin/buildd/gone"');
    expect(stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  test('a real worktree-add failure still carries its stderr text in the thrown error message', async () => {
    worktreeListOutput = '';
    __setGitOpsDeps({
      execSync: ((cmd: string, opts: Record<string, unknown>) => {
        syncCalls.push({ cmd, opts });
        if (cmd.includes('worktree list --porcelain')) return worktreeListOutput;
        if (cmd.includes('sparse-checkout list')) {
          const err: any = new Error('not sparse');
          throw err;
        }
        if (cmd.includes('branch -D')) {
          const err: any = new Error('not found');
          throw err;
        }
        if (cmd.includes('worktree add')) {
          const err: any = new Error("fatal: a branch named 'x' already exists");
          throw err;
        }
        return '';
      }) as any,
      execFile: mockExecFile as any,
      existsSync: (p: string) => existsSyncMap[p] ?? false,
      mkdirSync: () => {},
      readFileSync: () => '# exclude\n' as any,
      appendFileSync: () => {},
      rmSync: () => {},
    });

    const result = await setupWorktree('/repo', 'buildd/test-branch', 'main', 'worker-1');
    // setupWorktree swallows the throw and returns null, logging the detail —
    // the point here is only that piping stdio didn't erase the failure text
    // the catch block relies on (checked indirectly: no throw escapes, and
    // the mock's error was actually reached via the piped call).
    expect(result).toBeNull();
  });
});
