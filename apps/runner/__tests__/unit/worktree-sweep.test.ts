/**
 * Unit tests for the pure worktree-sweep helpers in worktree-utils.ts:
 *   - parseWorktreeList (git porcelain parsing)
 *   - isBuilddTaskBranch (which branches the sweep may touch)
 *   - shouldRemoveWorktree (the safety gates)
 *
 * Run: bun test apps/runner/__tests__/unit/worktree-sweep.test.ts
 */

import { describe, it, expect } from 'bun:test';
import {
  parseWorktreeList,
  isBuilddTaskBranch,
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

describe('isBuilddTaskBranch', () => {
  it('matches buildd/ task branches', () => {
    expect(isBuilddTaskBranch('buildd/abc-fix')).toBe(true);
  });
  it('matches e2e ephemeral branches', () => {
    expect(isBuilddTaskBranch('buildd/abc--e2e-test-echo')).toBe(true);
    expect(isBuilddTaskBranch('task--e2e-test-x')).toBe(true);
  });
  it('never matches human/default branches', () => {
    expect(isBuilddTaskBranch('main')).toBe(false);
    expect(isBuilddTaskBranch('dev')).toBe(false);
    expect(isBuilddTaskBranch('feature/foo')).toBe(false);
  });
  it('handles null/undefined', () => {
    expect(isBuilddTaskBranch(null)).toBe(false);
    expect(isBuilddTaskBranch(undefined)).toBe(false);
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
