/**
 * Regression: N tasks of one mission resolved to ONE worktree directory.
 *
 * The root cause is a keying mismatch, not intended concurrency.
 *
 *  - `generateTaskBranchName` gives every task in a mission the same shared
 *    head branch (`sharedHeadBranch` wins outright — see branch-names.ts).
 *  - `setupWorktree`'s candidate ladder then rejects *every* candidate derived
 *    from that branch, because `looksLikeMissionIntegrationBranch` is a bare
 *    `startsWith('mission/')` test and the unique candidate is
 *    `<branch>-w<id8>`. So the loop never breaks and `actualBranch` keeps its
 *    pre-loop default — the per-worker unique branch.
 *  - But the worktree PATH was still derived from the pre-ladder `branch`.
 *
 * Branches were made unique; paths were not. N distinct branches, one
 * directory, and each new worker reclaimed the previous one's cwd.
 *
 * The same shape applies to a task whose branch IS the repo default branch:
 * the ladder diverts to `<default>-w<id8>` while every such worker computed
 * `.buildd-worktrees/<default>`.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worktree-path-collision.test.ts
 */

import { describe, test, expect, afterAll, beforeEach } from 'bun:test';

const MAIN_WORKTREE = '/repo';
const DEFAULT_BRANCH = 'dev';
// Synthetic, literal fixtures — the repo is public, so never a real id.
const MISSION_BRANCH = 'mission/tidy-the-thing-0000abcd';

type SyncCall = { cmd: string; opts: Record<string, unknown> };
let syncCalls: SyncCall[] = [];
/** branch → worktree path, mirroring `git worktree list --porcelain`. */
let worktrees: Map<string, string>;
let existingPaths: Set<string>;
let statusPorcelain = '';

function porcelain(): string {
  return [...worktrees.entries()]
    .map(([branch, path]) => `worktree ${path}\nHEAD 0000000\nbranch refs/heads/${branch}\n`)
    .join('\n');
}

function fail(message: string, status = 128): never {
  const err: any = new Error(`Command failed: ${message}`);
  err.status = status;
  err.stderr = message;
  throw err;
}

function mockExecSync(cmd: string, opts: Record<string, unknown>) {
  syncCalls.push({ cmd, opts });
  if (cmd.includes('worktree list --porcelain')) return porcelain();
  if (cmd.includes('sparse-checkout list')) fail('this worktree is not sparse', 1);
  if (cmd.includes('status --porcelain')) return statusPorcelain;
  if (cmd.includes('rev-list --count')) {
    if (cmd.includes('HEAD..origin/')) return '0';
    return '5';
  }
  const del = cmd.match(/git branch -D "([^"]+)"/);
  if (del) {
    const holder = worktrees.get(del[1]);
    if (holder) fail(`error: cannot delete branch '${del[1]}' used by worktree at '${holder}'`, 1);
    fail(`error: branch '${del[1]}' not found`, 1);
  }
  const rm = cmd.match(/git worktree remove --force "([^"]+)"/);
  if (rm) {
    existingPaths.delete(rm[1]);
    for (const [b, p] of worktrees) if (p === rm[1]) worktrees.delete(b);
    return '';
  }
  const add = cmd.match(/git worktree add -b "([^"]+)" "([^"]+)"/);
  if (add) {
    const [, branch, path] = add;
    if (worktrees.has(branch)) fail(`fatal: a branch named '${branch}' already exists`);
    if (existingPaths.has(path)) fail(`fatal: '${path}' already exists`);
    worktrees.set(branch, path);
    existingPaths.add(path);
    return '';
  }
  return '';
}

function mockExecFile(
  _file: string,
  _args: string[],
  _opts: Record<string, unknown>,
  cb: (err: Error | null, stdout?: string, stderr?: string) => void,
) {
  return cb(null, '', '');
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupWorktree, __setGitOpsDeps, __resetGitOpsDeps } = require('../../src/git-operations');

afterAll(() => {
  __resetGitOpsDeps();
});

beforeEach(() => {
  syncCalls = [];
  worktrees = new Map([[DEFAULT_BRANCH, MAIN_WORKTREE]]);
  existingPaths = new Set([MAIN_WORKTREE, `${MAIN_WORKTREE}/.git`]);
  statusPorcelain = '';
  __setGitOpsDeps({
    execSync: mockExecSync as any,
    execFile: mockExecFile as any,
    existsSync: (p: string) => existingPaths.has(p),
    mkdirSync: ((p: string) => { existingPaths.add(p); }) as any,
    readFileSync: (() => '# exclude\n') as any,
    appendFileSync: () => {},
    rmSync: ((p: string) => { existingPaths.delete(p); }) as any,
    sessionLog: () => {},
  });
});

const addCmds = () => syncCalls.filter(c => c.cmd.includes('git worktree add'));

describe('worktree path follows the branch that is actually checked out', () => {
  test('two tasks of one mission get DIFFERENT directories, not one shared one', async () => {
    const a = await setupWorktree(
      MAIN_WORKTREE, MISSION_BRANCH, DEFAULT_BRANCH, 'worker-a1',
      { baseBranch: MISSION_BRANCH },
    );
    const b = await setupWorktree(
      MAIN_WORKTREE, MISSION_BRANCH, DEFAULT_BRANCH, 'worker-b2',
      { baseBranch: MISSION_BRANCH },
    );

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // The defect: identical paths for distinct branches.
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
    // Each directory is named after the branch it actually holds.
    expect(a.path).toBe(`${MAIN_WORKTREE}/.buildd-worktrees/${a.branch.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    expect(b.path).toBe(`${MAIN_WORKTREE}/.buildd-worktrees/${b.branch.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    // And both `git worktree add` calls name distinct branches AND distinct paths.
    const adds = addCmds();
    expect(adds.length).toBe(2);
    expect(adds[0].cmd).not.toBe(adds[1].cmd);
  });

  test('a task whose branch is the repo default branch gets a worker-scoped directory', async () => {
    const a = await setupWorktree(MAIN_WORKTREE, DEFAULT_BRANCH, DEFAULT_BRANCH, 'worker-c3');
    const b = await setupWorktree(MAIN_WORKTREE, DEFAULT_BRANCH, DEFAULT_BRANCH, 'worker-d4');

    expect(a.path).not.toBe(b.path);
    // Never the bare `<default>` directory, which every such worker shared.
    expect(a.path).not.toBe(`${MAIN_WORKTREE}/.buildd-worktrees/${DEFAULT_BRANCH}`);
    expect(b.path).not.toBe(`${MAIN_WORKTREE}/.buildd-worktrees/${DEFAULT_BRANCH}`);
  });

  test('an ordinary per-task branch keeps its path byte-for-byte', async () => {
    // The overwhelmingly common case: the ladder does not divert, so nothing
    // about the path may change. Pins the existing contract.
    const result = await setupWorktree(MAIN_WORKTREE, 'buildd/0000abcd-slug', DEFAULT_BRANCH, 'worker-e5');

    expect(result.branch).toBe('buildd/0000abcd-slug');
    expect(result.path).toBe(`${MAIN_WORKTREE}/.buildd-worktrees/buildd_0000abcd-slug`);
  });

  test('a resume checkout keeps the task-branch-keyed path (unchanged behaviour)', async () => {
    // `actualBranch` is the resume branch here, which is NOT worker-scoped —
    // recomputing the path from it would make two tasks resuming one branch
    // collide on a directory, i.e. reintroduce the bug from the other side.
    const result = await setupWorktree(
      MAIN_WORKTREE, 'buildd/0000abcd-retry', DEFAULT_BRANCH, 'worker-f6',
      { resumeBranch: 'buildd/00001111-prior' },
    );

    expect(result.branch).toBe('buildd/00001111-prior');
    expect(result.path).toBe(`${MAIN_WORKTREE}/.buildd-worktrees/buildd_0000abcd-retry`);
  });

  test('the same worker retrying the same mission branch is idempotent (same path, leftover reclaimed)', async () => {
    const first = await setupWorktree(
      MAIN_WORKTREE, MISSION_BRANCH, DEFAULT_BRANCH, 'worker-g7', { baseBranch: MISSION_BRANCH },
    );
    // Its branch and directory are both still registered; the retry must land
    // on the same directory rather than accumulating `-w…-w…` suffixes.
    const second = await setupWorktree(
      MAIN_WORKTREE, MISSION_BRANCH, DEFAULT_BRANCH, 'worker-g7', { baseBranch: MISSION_BRANCH },
    );

    expect(second).not.toBeNull();
    expect(second.path).toBe(first.path);
  });
});
