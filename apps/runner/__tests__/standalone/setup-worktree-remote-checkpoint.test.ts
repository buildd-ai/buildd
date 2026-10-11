/**
 * Real-git test: a task branch that already exists on origin (e.g. a
 * usage-limit checkpoint pushed by an earlier worker) is resumed even when the
 * task context carries no `resumeBranch`. Without this the fresh worktree was
 * cut from the default branch and the first push failed non-fast-forward.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/standalone/setup-worktree-remote-checkpoint.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { setupWorktree } from '../../src/git-operations';

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
}
function rm(dir: string) {
  execSync(`rm -rf "${dir}"`);
}

function makeRepoWithOrigin(): { bareDir: string; repoPath: string; barePath: string } {
  const bareDir = mkdtempSync(join(tmpdir(), 'buildd-test-bare-ckpt-'));
  const barePath = join(bareDir, 'origin.git');
  execSync(`git init --bare -b main "${barePath}"`, { encoding: 'utf-8' });
  const seedDir = mkdtempSync(join(tmpdir(), 'buildd-test-seed-ckpt-'));
  sh(`git clone "${barePath}" .`, seedDir);
  sh('git config user.email test@buildd.dev', seedDir);
  sh('git config user.name buildd-test', seedDir);
  sh('git commit --allow-empty -m "initial commit"', seedDir);
  sh('git push origin main', seedDir);
  rm(seedDir);
  const repoDir = mkdtempSync(join(tmpdir(), 'buildd-test-repo-ckpt-'));
  const repoPath = join(repoDir, 'clone');
  sh(`git clone "${barePath}" "${repoPath}"`, repoDir);
  sh('git config user.email test@buildd.dev', repoPath);
  sh('git config user.name buildd-test', repoPath);
  return { bareDir, repoPath, barePath };
}

/** Push a checkpoint commit to origin/<branch> from a throwaway clone. */
function pushCheckpoint(barePath: string, branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'buildd-test-ckpt-'));
  try {
    sh(`git clone "${barePath}" .`, dir);
    sh('git config user.email test@buildd.dev', dir);
    sh('git config user.name buildd-test', dir);
    sh(`git checkout -b "${branch}"`, dir);
    sh('git commit --allow-empty -m "wip: checkpoint after usage limit"', dir);
    const sha = sh('git rev-parse HEAD', dir);
    sh(`git push origin "${branch}"`, dir);
    return sha;
  } finally {
    rm(dir);
  }
}

describe('setupWorktree — remote checkpoint without resumeBranch (real git)', () => {
  test('builds on origin/<branch> when it exists and no resumeBranch is given', async () => {
    const { bareDir, repoPath, barePath } = makeRepoWithOrigin();
    try {
      const branch = 'buildd/e9b763d8-refactor-x';
      const sha = pushCheckpoint(barePath, branch);

      const result = await setupWorktree(repoPath, branch, 'main', 'wckpt0001', {});

      expect(result).not.toBeNull();
      expect(sh('git log --format=%H', result!.path).split('\n')).toContain(sha);
      expect(result!.branch).toBe(branch);
      // A fast-forward push must work.
      sh('git commit --allow-empty -m next', result!.path);
      sh(`git push origin HEAD:refs/heads/${branch}`, result!.path);
    } finally {
      rm(bareDir);
      rm(join(repoPath, '..'));
    }
  });

  test('a fresh branch absent from origin still starts from the default branch', async () => {
    const { bareDir, repoPath } = makeRepoWithOrigin();
    try {
      const result = await setupWorktree(repoPath, 'buildd/fresh0001-x', 'main', 'wckpt0002', {});
      expect(result).not.toBeNull();
      expect(sh('git rev-parse HEAD', result!.path)).toBe(sh('git rev-parse origin/main', repoPath));
    } finally {
      rm(bareDir);
      rm(join(repoPath, '..'));
    }
  });
});
