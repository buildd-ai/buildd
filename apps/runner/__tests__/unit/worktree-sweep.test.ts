/**
 * Unit tests for the pure worktree-sweep helpers in worktree-utils.ts:
 *   - parseWorktreeList (git porcelain parsing)
 *   - isRunnerWorktreePath (which worktrees the sweep may touch)
 *   - shouldRemoveWorktree (the safety gates)
 *
 * Run: bun test apps/runner/__tests__/unit/worktree-sweep.test.ts
 */

import { describe, it, expect } from 'bun:test';
import {
  parseWorktreeList,
  isRunnerWorktreePath,
  isWorktreePathOwnedByOtherLiveWorker,
  formatWorktreeTelemetry,
  shouldRemoveWorktree,
  classifyOwner,
  candidateRepoRoots,
  STALE_WORKTREE_IDLE_MS,
  WAITING_WORKTREE_TTL_MS,
  type WorktreeOwnerRecord,
} from '../../src/worktree-utils';

describe('parseWorktreeList', () => {
  it('parses main + task worktrees with branches', () => {
    const porcelain = [
      'worktree /home/coder/.buildd',
      'HEAD deadbeef',
      'branch refs/heads/main',
      '',
      'worktree /home/coder/.buildd/roles/builder/.buildd-worktrees/buildd_abc-fix',
      'HEAD cafef00d',
      'branch refs/heads/buildd/abc-fix',
      '',
    ].join('\n');

    const entries = parseWorktreeList(porcelain);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ path: '/home/coder/.buildd', branch: 'main' });
    expect(entries[1]).toEqual({
      path: '/home/coder/.buildd/roles/builder/.buildd-worktrees/buildd_abc-fix',
      branch: 'buildd/abc-fix',
    });
  });

  it('reports detached/bare worktrees with null branch', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD deadbeef',
      'detached',
      '',
    ].join('\n');
    const entries = parseWorktreeList(porcelain);
    expect(entries).toEqual([{ path: '/repo', branch: null }]);
  });

  it('returns [] for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

/**
 * Regression: the sweep's eligibility filter was `isBuilddTaskBranch(wt.branch)`,
 * i.e. a `buildd/` prefix test. Every OTHER branch shape the runner creates was
 * therefore invisible to it: `mission/…`, `mission/…-w<id8>`, `task-<id8>` (the
 * `branchingStrategy: 'none'` shape), a workspace `branchPrefix`, and
 * `<default>-w<id8>`. Those are precisely the shapes that collided and leaked,
 * so the sweeper was structurally blind to its own backlog.
 *
 * Location is the authoritative signal: setupWorktree always builds under
 * `<repo>/.buildd-worktrees/`. Branch-name prefixes are not.
 */
describe('isRunnerWorktreePath (eligibility by location, not branch name)', () => {
  const base = '/home/coder/.buildd/roles/builder/.buildd-worktrees';

  for (const dir of [
    'buildd_0000abcd-slug',
    'mission_tidy-0000abcd',
    'mission_tidy-0000abcd-w00001111',
    'task-0000abcd',
    'acme-0000abcd-slug',
    'dev-w00001111',
  ]) {
    it(`recognises the runner-created directory ${dir}`, () => {
      expect(isRunnerWorktreePath(`${base}/${dir}`)).toBe(true);
    });
  }

  it('does not recognise a worktree outside .buildd-worktrees', () => {
    // A human feature branch checkout, or an SDK `isolation: 'worktree'`
    // subagent tree — neither is ours to reap.
    expect(isRunnerWorktreePath('/home/coder/work/feature-x')).toBe(false);
    expect(isRunnerWorktreePath('/home/coder/.claude/worktrees/agent-0000abcd')).toBe(false);
  });

  it('does not recognise a lookalike directory name', () => {
    expect(isRunnerWorktreePath('/repo/my-buildd-worktrees-backup/x')).toBe(false);
  });

  it('handles the base directory itself and empty input', () => {
    expect(isRunnerWorktreePath(base)).toBe(true);
    expect(isRunnerWorktreePath('')).toBe(false);
  });
});

describe('shouldRemoveWorktree safety gates', () => {
  const idle = STALE_WORKTREE_IDLE_MS + 1;

  it('never removes a worktree that is not idle long enough', () => {
    expect(shouldRemoveWorktree({
      idleMs: STALE_WORKTREE_IDLE_MS - 1,
      idleThresholdMs: STALE_WORKTREE_IDLE_MS,
      owner: 'orphan',
      branchPushed: true,
    }).remove).toBe(false);
  });

  it('never removes a worktree owned by a live worker', () => {
    const r = shouldRemoveWorktree({ idleMs: idle, idleThresholdMs: STALE_WORKTREE_IDLE_MS, owner: 'live', branchPushed: true });
    expect(r.remove).toBe(false);
    expect(r.reason).toContain('live');
  });

  it('removes true orphans regardless of pushed state', () => {
    expect(shouldRemoveWorktree({ idleMs: idle, idleThresholdMs: STALE_WORKTREE_IDLE_MS, owner: 'orphan', branchPushed: false }).remove).toBe(true);
    expect(shouldRemoveWorktree({ idleMs: idle, idleThresholdMs: STALE_WORKTREE_IDLE_MS, owner: 'orphan', branchPushed: true }).remove).toBe(true);
  });

  it('removes terminal tasks only when the branch is pushed', () => {
    expect(shouldRemoveWorktree({ idleMs: idle, idleThresholdMs: STALE_WORKTREE_IDLE_MS, owner: 'terminal', branchPushed: true }).remove).toBe(true);
    const retained = shouldRemoveWorktree({ idleMs: idle, idleThresholdMs: STALE_WORKTREE_IDLE_MS, owner: 'terminal', branchPushed: false });
    expect(retained.remove).toBe(false);
    expect(retained.reason).toContain('unpushed');
  });

  it('waiting TTL matches the 24h worker-store TTL', () => {
    expect(WAITING_WORKTREE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('classifyOwner', () => {
  const wtPath = '/repo/.buildd-worktrees/buildd_task';
  const branch = 'buildd/task';
  const now = 1_000_000_000_000;
  const rec = (o: Partial<WorktreeOwnerRecord>): WorktreeOwnerRecord => ({ worktreePath: wtPath, branch, ...o });

  it('returns orphan when no record matches (e.g. aged out of the store)', () => {
    expect(classifyOwner([], wtPath, branch, now)).toBe('orphan');
    expect(classifyOwner([rec({ worktreePath: '/other', branch: 'buildd/other' })], wtPath, branch, now)).toBe('orphan');
  });

  it('matches an owner by worktree path or by branch', () => {
    expect(classifyOwner([rec({ status: 'working', branch: 'buildd/other' })], wtPath, branch, now)).toBe('live'); // path match
    expect(classifyOwner([rec({ status: 'working', worktreePath: '/other' })], wtPath, branch, now)).toBe('live'); // branch match
  });

  it('treats working/stale as live', () => {
    expect(classifyOwner([rec({ status: 'working' })], wtPath, branch, now)).toBe('live');
    expect(classifyOwner([rec({ status: 'stale' })], wtPath, branch, now)).toBe('live');
  });

  it('treats done/error as terminal', () => {
    expect(classifyOwner([rec({ status: 'done' })], wtPath, branch, now)).toBe('terminal');
    expect(classifyOwner([rec({ status: 'error' })], wtPath, branch, now)).toBe('terminal');
  });

  it('treats waiting as live within the 24h TTL and terminal past it', () => {
    expect(classifyOwner([rec({ status: 'waiting', lastActivity: now - 60_000 })], wtPath, branch, now)).toBe('live');
    expect(classifyOwner([rec({ status: 'waiting', lastActivity: now - (WAITING_WORKTREE_TTL_MS + 1) })], wtPath, branch, now)).toBe('terminal');
  });
});

/**
 * Regression: `runCleanup` logged the sweep's message only when it did NOT
 * start with "No stale". Combined with the branch-prefix eligibility filter
 * above, a runner that was leaking worktrees but whose leaks were all filtered
 * out logged nothing at all — zero runtime worktree/disk telemetry, so the only
 * way to see a leak was to SSH in and run `git worktree list`.
 */
describe('formatWorktreeTelemetry', () => {
  it('emits a line even when every counter is zero', () => {
    const line = formatWorktreeTelemetry({
      repos: 0, worktrees: 0, live: 0, terminal: 0, orphan: 0,
      removable: 0, diskMB: 0, reaped: 0, skippedOwned: 0,
    });
    expect(line).toContain('[worktree-telemetry]');
    expect(line).toContain('worktrees=0');
    expect(line).toContain('reaped=0');
  });

  it('names every counter so the line is greppable and chartable', () => {
    const line = formatWorktreeTelemetry({
      repos: 3, worktrees: 12, live: 4, terminal: 5, orphan: 3,
      removable: 6, diskMB: 900, reaped: 6, skippedOwned: 2,
    });
    for (const kv of [
      'repos=3', 'worktrees=12', 'live=4', 'terminal=5', 'orphan=3',
      'removable=6', 'diskMB=900', 'reaped=6', 'skipped_owned=2',
    ]) {
      expect(line).toContain(kv);
    }
    expect(line).not.toContain('WARN');
  });

  it('flags a leaking or bloated runner inline', () => {
    const leaking = formatWorktreeTelemetry({
      repos: 1, worktrees: 40, live: 1, terminal: 2, orphan: 37,
      removable: 0, diskMB: 6000, reaped: 0, skippedOwned: 0,
    });
    expect(leaking).toContain('WARN');
  });
});

describe('sweep ownership uses the same predicate as teardown', () => {
  it('a path held by a live in-memory worker is protected even if records say orphan', () => {
    // The persisted record can lag (the store writes on a cadence), so
    // classifyOwner alone can call a live worker's tree an orphan.
    const path = '/repo/.buildd-worktrees/buildd_0000abcd-slug';
    expect(classifyOwner([], path, 'buildd/0000abcd-slug')).toBe('orphan');
    expect(isWorktreePathOwnedByOtherLiveWorker(
      new Map([['w-1', { worktreePath: path, status: 'working' }]]),
      path,
      '__sweep__',
    )).toBe(true);
  });
});

describe('candidateRepoRoots (blind-spot fix)', () => {
  // Simulated layout: buildd self-repo + a role checkout + a project repo.
  const buildd = '/home/coder/.buildd';
  const project = '/home/coder/project';
  const gitRepos = new Set([
    `${buildd}/.git`,
    `${buildd}/roles/builder/.git`,
    `${project}/some-repo/.git`,
  ]);
  const dirs: Record<string, string[]> = {
    [`${buildd}/roles`]: ['builder', 'reviewer'],
    [project]: ['some-repo', 'not-a-repo'],
  };
  const roots = candidateRepoRoots({
    builddDir: buildd,
    projectDir: project,
    isGitRepo: (dir) => gitRepos.has(`${dir}/.git`),
    listDir: (dir) => dirs[dir] ?? [],
    joinPath: (...parts) => parts.join('/'),
  });

  it('includes the buildd self-repo (previously never scanned)', () => {
    expect(roots).toContain(buildd);
  });

  it('includes buildd role checkouts (where the leaking worktrees lived)', () => {
    expect(roots).toContain(`${buildd}/roles/builder`);
  });

  it('still includes project workspace repos', () => {
    expect(roots).toContain(`${project}/some-repo`);
  });

  it('excludes non-git dirs', () => {
    expect(roots).not.toContain(`${buildd}/roles/reviewer`);
    expect(roots).not.toContain(`${project}/not-a-repo`);
  });
});
