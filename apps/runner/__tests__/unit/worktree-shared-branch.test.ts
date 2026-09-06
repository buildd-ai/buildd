/**
 * Regression: concurrent tasks whose context carries `baseBranch`/`resumeBranch`
 * equal to the repo default branch (e.g. "dev") all tried to create a worktree
 * ON a branch literally named `dev`.
 *
 * All role clones are worktrees of ONE repo and share a single branch namespace,
 * so only one worktree may hold a given branch. Observed in production:
 *
 *   [Worker e564ef64] Creating worktree: … (branch: dev, base: origin/dev)
 *   error: cannot delete branch 'dev' used by worktree at '…/buildd_6e42df10--…'
 *   fatal: a branch named 'dev' already exists
 *   [Worker e564ef64] Worktree setup failed, falling back to main repo
 *
 * The fallback runs the agent in the SHARED role-clone root: no filesystem
 * isolation between concurrent workers, and no CBM (worktreePath unset).
 *
 * Fix: never check a worktree out onto the default branch or onto a branch that
 * another worktree already holds — use the task's own branch instead. Resuming a
 * real feature branch (to push to an existing PR) must still work.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worktree-shared-branch.test.ts
 */

import { describe, test, expect, afterAll, beforeEach } from 'bun:test';

// ─── Fake git ────────────────────────────────────────────────────────────────
// Enough of git's worktree semantics to reproduce the collision: one branch may
// be checked out by at most one worktree, and a branch held by a worktree can be
// neither deleted nor re-created.

type SyncCall = { cmd: string; opts: Record<string, unknown> };

const syncCalls: SyncCall[] = [];
/** branch → worktree path (mirrors `git worktree list --porcelain`) */
let worktrees: Map<string, string>;
const MAIN_WORKTREE = '/repo';
const DEFAULT_BRANCH = 'dev';

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

  // Non-sparse repo → non-zero exit.
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
    // This is the exact production error line.
    if (holder) fail(`error: cannot delete branch '${branch}' used by worktree at '${holder}'`, 1);
    fail(`error: branch '${branch}' not found`, 1);
  }

  const add = cmd.match(/git worktree add -b "([^"]+)" "([^"]+)"/);
  if (add) {
    const [, branch, path] = add;
    // The production fatal: the branch namespace is shared across worktrees.
    if (worktrees.has(branch)) fail(`fatal: a branch named '${branch}' already exists`);
    worktrees.set(branch, path);
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
  return cb(null, '', ''); // bun install — irrelevant here
}

// Load the real module (see git-operations.test.ts for why require() not import).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupWorktree, __setGitOpsDeps, __resetGitOpsDeps } = require('../../src/git-operations');

function injectDeps() {
  __setGitOpsDeps({
    execSync: mockExecSync as any,
    execFile: mockExecFile as any,
    existsSync: () => false,
    mkdirSync: () => {},
    readFileSync: () => '# exclude\n' as any,
    appendFileSync: () => {},
    rmSync: () => {},
  });
}

afterAll(() => {
  __resetGitOpsDeps();
});

beforeEach(() => {
  syncCalls.length = 0;
  // The main repo checkout always holds the default branch.
  worktrees = new Map([[DEFAULT_BRANCH, MAIN_WORKTREE]]);
  injectDeps();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('setupWorktree — shared/default branch guard', () => {
  test('two concurrent tasks with baseBranch=<default> each get their own worktree on their own task branch', async () => {
    const ctxA: Record<string, unknown> = { baseBranch: DEFAULT_BRANCH };
    const ctxB: Record<string, unknown> = { baseBranch: DEFAULT_BRANCH };

    const a = await setupWorktree(MAIN_WORKTREE, 'buildd/task-a', DEFAULT_BRANCH, 'worker-a', ctxA);
    const b = await setupWorktree(MAIN_WORKTREE, 'buildd/task-b', DEFAULT_BRANCH, 'worker-b', ctxB);

    // Both workers keep an isolated worktree — no fallback to the shared repo root.
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    // Each is on its OWN task branch, never on the shared default branch.
    expect(a.branch).toBe('buildd/task-a');
    expect(b.branch).toBe('buildd/task-b');
    expect(a.branch).not.toBe(DEFAULT_BRANCH);
    expect(b.branch).not.toBe(DEFAULT_BRANCH);

    // Distinct directories.
    expect(a.path).not.toBe(b.path);
    expect(a.path).toBe('/repo/.buildd-worktrees/buildd_task-a');
    expect(b.path).toBe('/repo/.buildd-worktrees/buildd_task-b');

    // Both still branch off the default branch's remote tip.
    const adds = syncCalls.filter(c => c.cmd.includes('git worktree add'));
    expect(adds.length).toBe(2);
    for (const add of adds) expect(add.cmd).toContain(`"origin/${DEFAULT_BRANCH}"`);

    // The default branch is still held only by the main checkout.
    expect(worktrees.get(DEFAULT_BRANCH)).toBe(MAIN_WORKTREE);
  });

  test('never runs `git worktree add -b <default-branch>` or deletes the default branch', async () => {
    await setupWorktree(MAIN_WORKTREE, 'buildd/task-a', DEFAULT_BRANCH, 'worker-a', { baseBranch: DEFAULT_BRANCH });

    expect(syncCalls.some(c => c.cmd.includes(`git worktree add -b "${DEFAULT_BRANCH}"`))).toBe(false);
    expect(syncCalls.some(c => c.cmd.includes(`git branch -D "${DEFAULT_BRANCH}"`))).toBe(false);
  });

  // `baseBranch: <default>` with no `resumeBranch` never actually attempted a
  // direct checkout of the default branch — declared-base semantics only ever
  // wanted it as a base to cut FROM (see git-operations.ts's resumeCandidate,
  // which now reads `resumeBranch` only). So there is nothing to warn about
  // here: the task lands on its own branch on the first try, not via a
  // rejected candidate. A genuine resume onto the default branch (context.
  // resumeBranch === defaultBranch — pathological, but possible) still hits
  // the guard; see the next test.
  test('baseBranch=<default> alone never attempts the default branch as a checkout target — no guard needed', async () => {
    const result = await setupWorktree(
      MAIN_WORKTREE, 'buildd/task-a', DEFAULT_BRANCH, 'worker-a', { baseBranch: DEFAULT_BRANCH },
    );

    expect(result.branch).toBe('buildd/task-a');
    expect(result.sharedBranch).toBeUndefined();
  });

  test('resumeBranch=<default> (genuine resume attempt) still trips the guard', async () => {
    const result = await setupWorktree(
      MAIN_WORKTREE, 'buildd/task-a', DEFAULT_BRANCH, 'worker-a', { resumeBranch: DEFAULT_BRANCH },
    );

    expect(result.branch).toBe('buildd/task-a');
    expect(result.sharedBranch).toBeTruthy();
    expect(result.sharedBranch.candidate).toBe(DEFAULT_BRANCH);
    expect(result.sharedBranch.reason).toBe('default_branch');
  });

  test('resume candidate already checked out by another live worktree → own task branch, holder named', async () => {
    // Worker A resumes a real feature branch (the behaviour actualBranch exists for).
    const a = await setupWorktree(
      MAIN_WORKTREE, 'buildd/retry-a', DEFAULT_BRANCH, 'worker-a', { resumeBranch: 'buildd/prior' },
    );
    expect(a.branch).toBe('buildd/prior'); // NOT regressed

    // Worker B asks for the same resume branch while A still holds it.
    const b = await setupWorktree(
      MAIN_WORKTREE, 'buildd/retry-b', DEFAULT_BRANCH, 'worker-b', { resumeBranch: 'buildd/prior' },
    );
    expect(b).not.toBeNull();
    expect(b.branch).toBe('buildd/retry-b');
    expect(b.sharedBranch.candidate).toBe('buildd/prior');
    expect(b.sharedBranch.reason).toBe('checked_out');
    expect(b.sharedBranch.holder).toBe(a.path);
  });

  test('resuming a real feature branch still checks out that branch (no regression)', async () => {
    const result = await setupWorktree(
      MAIN_WORKTREE, 'buildd/retry-task', DEFAULT_BRANCH, 'worker-r', { resumeBranch: 'buildd/prior-attempt' },
    );

    expect(result.branch).toBe('buildd/prior-attempt');
    expect(result.sharedBranch).toBeUndefined();
    const add = syncCalls.find(c => c.cmd.includes('git worktree add'));
    expect(add.cmd).toContain('-b "buildd/prior-attempt"');
    expect(add.cmd).toContain('"origin/buildd/prior-attempt"');
  });

  // The task's own branch is NOT automatically a safe fallback. A mission
  // carries a stable `headBranch` across cycles, so two concurrent workers in
  // one mission are handed the SAME task branch; and a task cut against the
  // default branch has `branch === defaultBranch`. Gating the guard on
  // `requestedBranch !== branch` left both holes open — same collision, one
  // door along — so the loser was still degraded into the shared clone root.
  test('task branch itself already held → falls back to a per-worker unique branch', async () => {
    worktrees.set('buildd/mission-cycle', '/repo/.buildd-worktrees/buildd_mission-cycle');

    const result = await setupWorktree(
      MAIN_WORKTREE, 'buildd/mission-cycle', DEFAULT_BRANCH, 'worker-b2',
    );

    expect(result).not.toBeNull();
    // Own worktree, not the shared root — the whole point.
    expect(result.path).not.toBe(MAIN_WORKTREE);
    expect(result.branch).toBe('buildd/mission-cycle-wworker-b');
    expect(result.sharedBranch.candidate).toBe('buildd/mission-cycle');
    expect(result.sharedBranch.reason).toBe('checked_out');
    expect(result.sharedBranch.holder).toBe('/repo/.buildd-worktrees/buildd_mission-cycle');
    // The branch another worktree holds must never be deleted or re-created.
    expect(syncCalls.some(c => c.cmd.includes('git branch -D "buildd/mission-cycle"'))).toBe(false);
  });

  test('task branch IS the default branch → per-worker unique branch, default branch untouched', async () => {
    const result = await setupWorktree(MAIN_WORKTREE, DEFAULT_BRANCH, DEFAULT_BRANCH, 'worker-c3');

    expect(result).not.toBeNull();
    expect(result.branch).toBe(`${DEFAULT_BRANCH}-wworker-c`);
    expect(result.sharedBranch.reason).toBe('default_branch');
    expect(syncCalls.some(c => c.cmd.includes(`git worktree add -b "${DEFAULT_BRANCH}"`))).toBe(false);
    expect(worktrees.get(DEFAULT_BRANCH)).toBe(MAIN_WORKTREE);
  });

  test('legible failure: when worktree add still fails, the error names the branch and the holding worktree', async () => {
    // Every candidate is held — the task branch AND the per-worker unique branch
    // derived from it — so no substitute exists and the add genuinely fails.
    worktrees.set('buildd/task-a', '/repo/.buildd-worktrees/buildd_task-a-old');
    worktrees.set('buildd/task-a-wworker-a', '/repo/.buildd-worktrees/buildd_task-a-uniq');

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const result = await setupWorktree(MAIN_WORKTREE, 'buildd/task-a', DEFAULT_BRANCH, 'worker-a');
      expect(result).toBeNull();
    } finally {
      console.error = originalError;
    }

    const msg = errors.join('\n');
    expect(msg).toContain('buildd/task-a');
    expect(msg).toContain('/repo/.buildd-worktrees/buildd_task-a-uniq');
  });
});
