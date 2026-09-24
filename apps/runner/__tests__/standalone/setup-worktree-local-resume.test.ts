/**
 * Real-git tests for setupWorktree's local-branch resume path.
 *
 * In standalone/ (not unit/) because these use the module's REAL execSync —
 * unit/ test files mock.module('fs')/inject fake execSync via
 * __setGitOpsDeps, and this suite deliberately does neither, to exercise the
 * actual git plumbing against a real temp repo + bare origin (no
 * mock.module), per the task's acceptance criteria.
 *
 * Bug being fixed: a worker commits to its task branch but is killed before
 * pushing. Task branches are stable across retries, so a retry requests the
 * SAME branch as both `branch` and `context.resumeBranch`. `origin/<branch>`
 * is missing (never pushed), so the old code treated it as gone, cleared the
 * resume context, and — worse — the "delete stale local branches" loop ran
 * `git branch -D` on the only ref holding those commits before recreating the
 * branch fresh from origin's default branch. The fix: resume directly from
 * the local branch when it exists and carries commits origin's default
 * doesn't have, and never delete a local branch that isn't an ancestor of
 * either origin's default or its own remote tip.
 *
 * Run: bun test apps/runner/__tests__/standalone/setup-worktree-local-resume.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { setupWorktree } from '../../src/git-operations';

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
}

function rm(dir: string) {
  execSync(`rm -rf "${dir}"`);
}

/** A bare origin seeded with one commit on `main`, plus a clone of it. */
function makeRepoWithOrigin(label: string): { bareDir: string; repoPath: string } {
  const bareDir = mkdtempSync(join(tmpdir(), `buildd-test-bare-${label}-`));
  const barePath = join(bareDir, 'origin.git');
  execSync(`git init --bare -b main "${barePath}"`, { encoding: 'utf-8' });

  const seedDir = mkdtempSync(join(tmpdir(), `buildd-test-seed-${label}-`));
  sh(`git clone "${barePath}" .`, seedDir);
  sh('git config user.email test@buildd.dev', seedDir);
  sh('git config user.name buildd-test', seedDir);
  sh('git commit --allow-empty -m "initial commit"', seedDir);
  sh('git push origin main', seedDir);
  rm(seedDir);

  const repoDir = mkdtempSync(join(tmpdir(), `buildd-test-repo-${label}-`));
  const repoPath = join(repoDir, 'clone');
  sh(`git clone "${barePath}" "${repoPath}"`, repoDir);
  sh('git config user.email test@buildd.dev', repoPath);
  sh('git config user.name buildd-test', repoPath);

  return { bareDir, repoPath };
}

/**
 * Create a local branch off origin/main carrying one commit that is NEVER
 * pushed, without disturbing repoPath's own checked-out branch — mirrors how
 * a prior worker's own (now-removed) worktree left the branch behind.
 */
function createUnpushedLocalBranch(repoPath: string, branchName: string, fileContent: string): string {
  const scratchDir = mkdtempSync(join(tmpdir(), 'buildd-test-scratch-'));
  sh(`git worktree add -b "${branchName}" "${scratchDir}" origin/main`, repoPath);
  sh('git config user.email test@buildd.dev', scratchDir);
  sh('git config user.name buildd-test', scratchDir);
  execSync(`echo "${fileContent}" > note.txt`, { cwd: scratchDir, shell: '/bin/sh' });
  sh('git add note.txt', scratchDir);
  sh(`git commit -m "unpushed work on ${branchName}"`, scratchDir);
  const sha = sh('git rev-parse HEAD', scratchDir);
  // Remove the worktree (simulating cleanup/crash recovery) — the branch ref
  // itself survives as a plain, non-checked-out local branch.
  sh(`git worktree remove --force "${scratchDir}"`, repoPath);
  return sha;
}

describe('setupWorktree — local-branch resume (real git)', () => {
  test('resumes from a local branch whose origin ref is missing, without losing the unpushed commit', async () => {
    const { bareDir, repoPath } = makeRepoWithOrigin('resume');
    try {
      const branch = 'buildd/abcd1234-x';
      const sha = createUnpushedLocalBranch(repoPath, branch, 'resume-me');

      const result = await setupWorktree(
        repoPath,
        branch,
        'main',
        'w2local01',
        { resumeBranch: branch, baseBranch: branch },
      );

      expect(result).not.toBeNull();
      // The commit must still be reachable from SOME ref...
      const containing = sh(`git branch --contains ${sha}`, repoPath);
      expect(containing.length).toBeGreaterThan(0);
      // ...and the new worktree's own HEAD must contain it (a real resume,
      // not just "preserved somewhere").
      const worktreeHead = sh('git log --format=%H -1', result!.path);
      const worktreeHistory = sh(`git log --format=%H`, result!.path).split('\n');
      expect(worktreeHistory).toContain(sha);
      expect(worktreeHead).toBeTruthy();
      // No fallback: this is a genuine resume, not a fresh start.
      expect(result!.fallback).toBeUndefined();
    } finally {
      rm(bareDir);
      rm(join(repoPath, '..'));
    }
  });

  test('an unpushed non-target local branch is renamed to an orphan branch, not deleted', async () => {
    const { bareDir, repoPath } = makeRepoWithOrigin('orphan');
    try {
      const resumeBranch = 'buildd/resume-target';
      const staleBranch = 'buildd/stale-non-target';
      const resumeSha = createUnpushedLocalBranch(repoPath, resumeBranch, 'resume-target-work');
      const staleSha = createUnpushedLocalBranch(repoPath, staleBranch, 'stale-non-target-work');

      const result = await setupWorktree(
        repoPath,
        staleBranch, // task's own branch parameter differs from the resume candidate
        'main',
        'w3orphan1',
        { resumeBranch, baseBranch: resumeBranch },
      );

      expect(result).not.toBeNull();
      // The resume target branch itself must never be touched by the deletion
      // loop — its commit is still reachable and the worktree resumed onto it.
      const resumeContaining = sh(`git branch --contains ${resumeSha}`, repoPath);
      expect(resumeContaining.length).toBeGreaterThan(0);

      // The non-target stale branch must be preserved under an orphan name,
      // not silently deleted.
      const allBranches = sh(`git branch --format="%(refname:short)"`, repoPath).split('\n');
      expect(allBranches).not.toContain(staleBranch);
      const orphan = allBranches.find(b => b.startsWith(`${staleBranch}-orphan-`));
      expect(orphan).toBeTruthy();
      const orphanContains = sh(`git branch --contains ${staleSha}`, repoPath);
      expect(orphanContains).toContain(orphan!);
    } finally {
      rm(bareDir);
      rm(join(repoPath, '..'));
    }
  });

  test('a fully merged (already-on-origin) stale local branch is still deleted', async () => {
    const { bareDir, repoPath } = makeRepoWithOrigin('merged');
    try {
      const mergedBranch = 'buildd/already-merged';
      // No unpushed work: branch points at the exact same commit as origin/main.
      sh(`git branch "${mergedBranch}" origin/main`, repoPath);

      const result = await setupWorktree(
        repoPath,
        mergedBranch,
        'main',
        'w4merged1',
      );

      expect(result).not.toBeNull();
      const allBranches = sh(`git branch --format="%(refname:short)"`, repoPath).split('\n');
      // The old (recreated-via -b) branch exists again because setupWorktree
      // cut it fresh for this worker, but no orphan copy should exist —
      // deletion, not preservation, is still correct for merged branches.
      expect(allBranches.some(b => b.startsWith(`${mergedBranch}-orphan-`))).toBe(false);
    } finally {
      rm(bareDir);
      rm(join(repoPath, '..'));
    }
  });
});
