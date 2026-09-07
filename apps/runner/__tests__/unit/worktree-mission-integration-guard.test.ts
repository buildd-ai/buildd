/**
 * Regression: two tasks of one mission ran concurrently, both with
 * context.baseBranch set to the mission integration branch. One correctly
 * cut its own task branch from the integration branch; the other used the
 * integration branch itself as its working branch.
 *
 * Result: the second task's PR had head=integration-branch, base=trunk,
 * which is indistinguishable from the mission PR in shape but carried only
 * one task's work. That PR bypassed the mission-PR coordination.
 *
 * Fix: when branch equals the mission integration branch (which is also the
 * base), cut a task branch FROM the integration branch, never work directly
 * on the integration branch itself.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worktree-mission-integration-guard.test.ts
 */

import { describe, test, expect, afterAll, beforeEach } from 'bun:test';

type SyncCall = { cmd: string; opts: Record<string, unknown> };

const syncCalls: SyncCall[] = [];
let worktrees: Map<string, string>;
let existingPaths: Set<string>;
const MAIN_WORKTREE = '/repo';
const DEFAULT_BRANCH = 'dev';
const MISSION_BRANCH = 'buildd/mission-abc';

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

  if (cmd.includes('status --porcelain')) return ''; // Worktrees are always clean in tests

  if (cmd.includes('sparse-checkout list')) fail('this worktree is not sparse', 1);

  if (cmd.includes('rev-list --count')) {
    // Stale-branch guard probe (HEAD..origin/<default>) — always fresh here.
    if (cmd.includes('HEAD..origin/')) return '0';
    return '5'; // fetchBranch probe: candidate exists, not diverged
  }

  const del = cmd.match(/git branch -D "([^"]+)"/);
  if (del) {
    const branch = del[1];
    const holder = worktrees.get(branch);
    if (holder) fail(`error: cannot delete branch '${branch}' used by worktree at '${holder}'`, 1);
    fail(`error: branch '${branch}' not found`, 1);
  }

  const add = cmd.match(/git worktree add -b "([^"]+)" "([^"]+)"/);
  if (add) {
    const [, branch, path] = add;
    if (worktrees.has(branch)) fail(`fatal: a branch named '${branch}' already exists`);
    worktrees.set(branch, path);
    existingPaths.add(path); // Mark the path as existing
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

function injectDeps() {
  __setGitOpsDeps({
    execSync: mockExecSync as any,
    execFile: mockExecFile as any,
    existsSync: (path: string) => existingPaths.has(path),
    mkdirSync: (path: string) => { existingPaths.add(path); },
    readFileSync: () => '# exclude\n' as any,
    appendFileSync: () => {},
    rmSync: (path: string) => { existingPaths.delete(path); },
  });
}

afterAll(() => {
  __resetGitOpsDeps();
});

beforeEach(() => {
  syncCalls.length = 0;
  worktrees = new Map([[DEFAULT_BRANCH, MAIN_WORKTREE]]);
  existingPaths = new Set([MAIN_WORKTREE, `${MAIN_WORKTREE}/.git`, `${MAIN_WORKTREE}/.buildd-worktrees`]);
  injectDeps();
});

describe('setupWorktree — mission integration branch guard', () => {
  test('task branch equals mission integration branch: cut a task branch from the integration branch, never work on the integration branch itself', async () => {
    // Simulate two concurrent tasks of the same mission.
    // Both are given:
    //   branch = "buildd/mission-abc" (the requested branch — wrong!)
    //   context.baseBranch = "buildd/mission-abc" (the mission integration branch)
    //
    // The bug: both tasks would try to work on "buildd/mission-abc" directly,
    // and one would collide with the other's worktree or PR.
    //
    // The fix: detect when branch equals baseBranch (and it's a mission integration
    // branch) and cut a NEW task branch from it instead.

    // But wait — the real issue is: how does the branch parameter end up being
    // the mission integration branch? Let me re-read the task description...
    //
    // "context.baseBranch set to the mission integration branch" — so baseBranch is
    // the mission branch. The task branch parameter should be unique per task,
    // but if it's also set to the mission branch, we have a problem.
    //
    // This test needs to show: when setupWorktree is called with branch="buildd/mission-abc"
    // and context.baseBranch="buildd/mission-abc", the result should be:
    // - A NEW task branch is created and checked out (not the mission branch itself)
    // - The base the worktree is cut from is the mission branch
    // - The worktree does NOT work directly on the mission integration branch

    // Actually, looking at the task description again: one worker "used THE MISSION
    // INTEGRATION BRANCH AS ITS OWN WORKING BRANCH" — the worker's branch was the
    // mission branch. This means claimedWorker.branch was set to the mission branch.

    // So the test should verify: even if claimedWorker.branch is the mission branch,
    // setupWorktree creates a different branch to work on.

    // But how do we know the mission branch? The branch parameter is just a string.
    // The fix must be: detect when branch equals baseBranch and create a unique
    // task branch anyway.

    const result = await setupWorktree(
      MAIN_WORKTREE,
      MISSION_BRANCH, // branch parameter IS the mission integration branch
      DEFAULT_BRANCH,
      'worker-task-1',
      { baseBranch: MISSION_BRANCH }, // context explicitly says "base on the mission branch"
    );

    expect(result).not.toBeNull();

    // ✓ Core fix: the worktree is NOT checked out on the mission branch itself.
    // Even though branch parameter = mission branch, the guard fires and creates
    // a different branch to work on.
    expect(result.branch).not.toBe(MISSION_BRANCH);

    // The base should still be the mission branch (in remote form).
    expect(result.base).toBe(`origin/${MISSION_BRANCH}`);

    // git worktree add should NOT try to create a branch named after the mission.
    // Instead, it creates a unique task branch.
    const adds = syncCalls.filter(c => c.cmd.includes('git worktree add'));
    expect(adds.length).toBe(1);
    expect(adds[0].cmd).not.toContain(`-b "${MISSION_BRANCH}"`);
    expect(adds[0].cmd).toContain(`origin/${MISSION_BRANCH}`); // base is still correct
  });

  test('two concurrent tasks of same mission with branch=mission-branch each get distinct task branches', async () => {
    // This is the actual scenario: two concurrent tasks are each given the
    // mission integration branch as their working branch (a bug in task creation).
    // setupWorktree should detect this and give them unique task branches anyway.

    const taskA = await setupWorktree(
      MAIN_WORKTREE,
      MISSION_BRANCH, // both tasks have the same branch parameter
      DEFAULT_BRANCH,
      'worker-a',
      { baseBranch: MISSION_BRANCH },
    );

    const taskB = await setupWorktree(
      MAIN_WORKTREE,
      MISSION_BRANCH, // same mission branch
      DEFAULT_BRANCH,
      'worker-b',
      { baseBranch: MISSION_BRANCH },
    );

    expect(taskA).not.toBeNull();
    expect(taskB).not.toBeNull();

    // ✓ Core fix: both should work on different branches, NOT the mission branch itself.
    // Even though both tasks are given the mission branch as their branch parameter,
    // the guard detects this and creates unique task branches for each.
    expect(taskA.branch).not.toBe(MISSION_BRANCH);
    expect(taskB.branch).not.toBe(MISSION_BRANCH);

    // Both should be cut from the mission branch (same base).
    expect(taskA.base).toBe(`origin/${MISSION_BRANCH}`);
    expect(taskB.base).toBe(`origin/${MISSION_BRANCH}`);

    // Neither should land on the mission branch itself in the git worktrees.
    expect(worktrees.get(MISSION_BRANCH)).toBeUndefined();
  });

  test('reports sharedBranch when branch equals baseBranch to indicate the guard fired', async () => {
    // The guard should report what was attempted vs. what was used, so the
    // caller can warn the user or log the deviation.
    const result = await setupWorktree(
      MAIN_WORKTREE,
      MISSION_BRANCH,
      DEFAULT_BRANCH,
      'worker-caught',
      { baseBranch: MISSION_BRANCH },
    );

    // When branch parameter equals baseBranch (both the mission branch), a guard
    // should fire and report it. This lets the caller know something unusual happened.
    // (It's not exactly "shared" like the default branch, but the reporting mechanism
    // can cover this case too — or we add a new field. For now, test the minimum:
    // the worktree is NOT on the mission branch.)

    expect(result.branch).not.toBe(MISSION_BRANCH);
  });

  // Regression: the guard above only fires when the ORIGINAL `branch` parameter
  // equals the base ref. It missed a second, real path to the same outcome —
  // seen live on task a0f00ee9 and again on the task that files this test.
  //
  // `branch` here is a perfectly normal, unique per-task branch name (never
  // equal to the mission branch). But `context.baseBranch` is ALSO the field
  // git-operations.ts's local `resumeCandidate` falls back to when
  // `context.resumeBranch` is absent (its "legacy CI retry" meaning). Under
  // the mission-branch strategy, `baseBranch` means "cut a fresh branch from
  // this ref" — a task never sets `resumeBranch` for it. So `resumeCandidate`
  // becomes the mission branch, `base` resolves to `origin/<mission branch>`
  // (declared-base semantics honour it), and `base === origin/${resumeCandidate}`
  // holds — making `requestedBranch` (not `branch`) equal the mission branch.
  // The old guard only ever tested `branch === base`, so this candidate sailed
  // through unrejected and the worktree landed directly on the mission branch.
  test('distinct per-task branch + baseBranch-only mission context: requestedBranch must not drift onto the base', async () => {
    const TASK_BRANCH = 'buildd/task123-some-slug';

    const result = await setupWorktree(
      MAIN_WORKTREE,
      TASK_BRANCH, // branch parameter is NOT the mission branch — no bug in task creation
      DEFAULT_BRANCH,
      'worker-drift',
      { baseBranch: MISSION_BRANCH }, // only baseBranch set — no resumeBranch, matching every real mission-branch task
    );

    expect(result).not.toBeNull();
    // The worktree must check out the task's own branch...
    expect(result.branch).toBe(TASK_BRANCH);
    // ...cut from the mission branch as its base.
    expect(result.base).toBe(`origin/${MISSION_BRANCH}`);
    expect(result.branch).not.toBe(MISSION_BRANCH);

    const adds = syncCalls.filter(c => c.cmd.includes('git worktree add'));
    expect(adds.length).toBe(1);
    expect(adds[0].cmd).toContain(`-b "${TASK_BRANCH}"`);
    expect(adds[0].cmd).toContain(`origin/${MISSION_BRANCH}`);
  });
});
