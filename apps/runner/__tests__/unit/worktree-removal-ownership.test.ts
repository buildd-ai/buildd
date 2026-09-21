/**
 * Regression: a worker force-removed a worktree directory that a DIFFERENT,
 * still-live worker had as its session `cwd`.
 *
 * The ownership predicate already existed, but it was module-private to
 * worker-sync.ts, so only the two eviction sites consulted it. Four other
 * removal sites (the clean-tree reclaim in setupWorktree, session-start
 * failure cleanup, the `finally` teardown and `destroy()`) went straight to
 * `git worktree remove --force`, which exits 0 after deleting another worker's
 * work. The victim's next command fails with `cd: no such file or directory`
 * because its cwd inode is gone.
 *
 * The second half of the defect: the reclaim's only gate was
 * `git status --porcelain`. An agent that had COMMITTED its work reads clean,
 * so a live session was the *easiest* thing to delete.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worktree-removal-ownership.test.ts
 */

import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import {
  isWorktreePathOwnedByOtherLiveWorker,
  type WorktreeOwnershipRecord,
} from '../../src/worktree-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { removeWorktreeIfUnowned, removeWorktreeIfUnownedSync, __setGitOpsDeps, __resetGitOpsDeps } =
  require('../../src/git-operations');

const REPO = '/repo';
const WT = '/repo/.buildd-worktrees/buildd_0000abcd-fix-thing';

// ─── Ownership predicate (pure) ──────────────────────────────────────────────

describe('isWorktreePathOwnedByOtherLiveWorker', () => {
  const live = ['working', 'stale', 'waiting', 'idle'] as const;
  const terminal = ['done', 'error'] as const;

  for (const status of live) {
    test(`status "${status}" counts as a live owner`, () => {
      const workers: Array<[string, WorktreeOwnershipRecord]> = [
        ['worker-b', { worktreePath: WT, status }],
      ];
      expect(isWorktreePathOwnedByOtherLiveWorker(workers, WT, 'worker-a')).toBe(true);
    });
  }

  for (const status of terminal) {
    test(`status "${status}" is terminal — not a live owner`, () => {
      const workers: Array<[string, WorktreeOwnershipRecord]> = [
        ['worker-b', { worktreePath: WT, status }],
      ];
      expect(isWorktreePathOwnedByOtherLiveWorker(workers, WT, 'worker-a')).toBe(false);
    });
  }

  test('the excluded worker itself never counts as another owner', () => {
    const workers: Array<[string, WorktreeOwnershipRecord]> = [
      ['worker-a', { worktreePath: WT, status: 'working' }],
    ];
    expect(isWorktreePathOwnedByOtherLiveWorker(workers, WT, 'worker-a')).toBe(false);
  });

  test('matching is exact — a trailing separator or a -w<id8> diversion is a different path', () => {
    const workers: Array<[string, WorktreeOwnershipRecord]> = [
      ['worker-b', { worktreePath: `${WT}/`, status: 'working' }],
      ['worker-c', { worktreePath: `${WT}-w0000abcd`, status: 'working' }],
    ];
    // Over-protecting by prefix would strand every diverted sibling directory.
    expect(isWorktreePathOwnedByOtherLiveWorker(workers, WT, 'worker-a')).toBe(false);
  });

  test('a worker with no worktreePath is ignored', () => {
    const workers: Array<[string, WorktreeOwnershipRecord]> = [['worker-b', { status: 'working' }]];
    expect(isWorktreePathOwnedByOtherLiveWorker(workers, WT, 'worker-a')).toBe(false);
  });

  test('accepts a Map directly (the runner passes this.workers)', () => {
    const workers = new Map<string, WorktreeOwnershipRecord>([
      ['worker-b', { worktreePath: WT, status: 'working' }],
    ]);
    expect(isWorktreePathOwnedByOtherLiveWorker(workers, WT, 'worker-a')).toBe(true);
  });
});

// ─── The single removal executor ─────────────────────────────────────────────

type SyncCall = { cmd: string; opts: Record<string, unknown> };
let syncCalls: SyncCall[] = [];
let rmCalls: string[] = [];
/** `git rev-list --count origin/<b>..<b>` result; null → the probe throws. */
let unpushedCount: string | null = '0';

function mockExecSync(cmd: string, opts: Record<string, unknown>) {
  syncCalls.push({ cmd, opts });
  if (cmd.includes('rev-list --count')) {
    if (unpushedCount === null) {
      const err: any = new Error('fatal: bad revision');
      err.status = 128;
      throw err;
    }
    return unpushedCount;
  }
  return '';
}

beforeEach(() => {
  syncCalls = [];
  rmCalls = [];
  unpushedCount = '0';
  __setGitOpsDeps({
    execSync: mockExecSync as any,
    execFile: (() => {}) as any,
    existsSync: () => true,
    mkdirSync: () => {},
    readFileSync: () => '' as any,
    appendFileSync: () => {},
    rmSync: ((p: string) => { rmCalls.push(p); }) as any,
    sessionLog: () => {},
  });
});

afterAll(() => {
  __resetGitOpsDeps();
});

const removals = () => syncCalls.filter(c => c.cmd.includes('worktree remove --force'));

describe('removeWorktreeIfUnowned', () => {
  test('a worker cannot remove a path another active worker owns', async () => {
    const workers = new Map<string, WorktreeOwnershipRecord>([
      ['worker-a', { worktreePath: WT, status: 'working' }],
      ['worker-b', { worktreePath: WT, status: 'working' }],
    ]);

    const outcome = await removeWorktreeIfUnowned({
      repoPath: REPO, worktreePath: WT, workerId: 'worker-b', workers,
    });

    expect(outcome).toEqual({ removed: false, reason: 'owned_by_live_worker' });
    // Zero `git worktree remove` AND zero rmSync — the fallback must not fire either.
    expect(removals()).toEqual([]);
    expect(rmCalls).toEqual([]);
  });

  test('a worker that has COMMITTED its work (clean git status) is still protected', async () => {
    // The clean-tree probe reads a committed-but-unpushed tree as reclaimable.
    // Ownership, not cleanliness, is what protects a live session's cwd.
    const workers = new Map<string, WorktreeOwnershipRecord>([
      ['worker-a', { worktreePath: WT, status: 'working' }],
    ]);
    unpushedCount = '3'; // committed, not pushed — and status would be clean

    const outcome = await removeWorktreeIfUnowned({
      repoPath: REPO, worktreePath: WT, workerId: 'worker-b', workers,
    });

    expect(outcome.removed).toBe(false);
    expect(removals()).toEqual([]);
    expect(rmCalls).toEqual([]);
  });

  test('a terminal owner is removable — exactly one force-remove on that path', async () => {
    const workers = new Map<string, WorktreeOwnershipRecord>([
      ['worker-a', { worktreePath: WT, status: 'done' }],
    ]);

    const outcome = await removeWorktreeIfUnowned({
      repoPath: REPO, worktreePath: WT, workerId: 'worker-b', workers,
    });

    expect(outcome).toEqual({ removed: true });
    expect(removals().length).toBe(1);
    expect(removals()[0].cmd).toContain(`"${WT}"`);
  });

  test('protectUnpushed refuses a tree with commits not on origin', async () => {
    unpushedCount = '3';

    const outcome = await removeWorktreeIfUnowned({
      repoPath: REPO, worktreePath: WT, workerId: 'worker-b', workers: new Map(),
      branch: 'buildd/0000abcd-fix-thing', protectUnpushed: true,
    });

    expect(outcome).toEqual({ removed: false, reason: 'unpushed_commits' });
    expect(removals()).toEqual([]);
    expect(rmCalls).toEqual([]);
  });

  test('protectUnpushed fails closed when the probe itself throws', async () => {
    unpushedCount = null;

    const outcome = await removeWorktreeIfUnowned({
      repoPath: REPO, worktreePath: WT, workerId: 'worker-b', workers: new Map(),
      branch: 'buildd/0000abcd-fix-thing', protectUnpushed: true,
    });

    expect(outcome).toEqual({ removed: false, reason: 'unpushed_commits' });
    expect(removals()).toEqual([]);
  });

  test('protectUnpushed allows removal once everything is pushed', async () => {
    unpushedCount = '0';

    const outcome = await removeWorktreeIfUnowned({
      repoPath: REPO, worktreePath: WT, workerId: 'worker-b', workers: new Map(),
      branch: 'buildd/0000abcd-fix-thing', protectUnpushed: true,
    });

    expect(outcome).toEqual({ removed: true });
    expect(removals().length).toBe(1);
  });
});

describe('removeWorktreeIfUnownedSync (destroy() path)', () => {
  test('refuses a live owner without shelling out', () => {
    const workers = new Map<string, WorktreeOwnershipRecord>([
      ['worker-a', { worktreePath: WT, status: 'working' }],
    ]);

    const outcome = removeWorktreeIfUnownedSync({
      repoPath: REPO, worktreePath: WT, workerId: 'worker-b', workers,
    });

    expect(outcome).toEqual({ removed: false, reason: 'owned_by_live_worker' });
    expect(removals()).toEqual([]);
    expect(rmCalls).toEqual([]);
  });

  test('removes synchronously when unowned', () => {
    const outcome = removeWorktreeIfUnownedSync({
      repoPath: REPO, worktreePath: WT, workerId: 'worker-b', workers: new Map(),
    });

    expect(outcome).toEqual({ removed: true });
    expect(removals().length).toBe(1);
    expect(removals()[0].cmd).toContain(`"${WT}"`);
  });
});
