/**
 * Git operations for worker sessions — worktree setup/cleanup and stats collection.
 * Extracted from WorkerManager to reduce workers.ts complexity.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveWorktreeBase } from './worktree-utils';

export interface GitStats {
  commitCount?: number;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  lastCommitSha?: string;
}

/**
 * Set up an isolated git worktree for a worker session.
 * Worktrees live in .buildd-worktrees/ inside the repo.
 */
export async function setupWorktree(
  repoPath: string,
  branch: string,
  defaultBranch: string,
  workerId: string,
  taskContext?: Record<string, unknown>,
): Promise<string | null> {
  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const execOpts = { cwd: repoPath, timeout: 30000, encoding: 'utf-8' as const };

  // Worktrees live in .buildd-worktrees/ inside the repo
  const worktreeBase = join(repoPath, '.buildd-worktrees');
  const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, '_');
  const worktreePath = join(worktreeBase, safeBranch);

  try {
    // Ensure worktree base directory exists
    fs.mkdirSync(worktreeBase, { recursive: true });

    // Add .buildd-worktrees to .git/info/exclude if not already there
    const excludePath = join(repoPath, '.git', 'info', 'exclude');
    if (existsSync(excludePath)) {
      const excludeContent = readFileSync(excludePath, 'utf-8');
      if (!excludeContent.includes('.buildd-worktrees')) {
        fs.appendFileSync(excludePath, '\n.buildd-worktrees\n');
      }
    }

    // Fetch latest from remote
    console.log(`[Worker ${workerId}] Fetching latest from remote...`);
    try {
      execSync('git fetch origin', execOpts);
    } catch (err) {
      console.warn(`[Worker ${workerId}] git fetch failed (continuing with local state):`, err instanceof Error ? err.message : err);
    }

    // Clean up stale worktree at this path if it exists
    if (existsSync(worktreePath)) {
      console.log(`[Worker ${workerId}] Cleaning up stale worktree at ${worktreePath}`);
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, execOpts);
      } catch {
        // Force-remove the directory if git worktree remove fails
        fs.rmSync(worktreePath, { recursive: true, force: true });
        try { execSync('git worktree prune', execOpts); } catch {}
      }
    }

    // Delete the branch if it already exists locally (stale from previous run)
    try {
      execSync(`git branch -D "${branch}"`, execOpts);
    } catch {
      // Branch doesn't exist locally, that's fine
    }

    // Create worktree with new branch — from baseBranch (retry) or default branch (fresh)
    const base = resolveWorktreeBase(defaultBranch, taskContext);
    console.log(`[Worker ${workerId}] Creating worktree: ${worktreePath} (branch: ${branch}, base: ${base})`);
    execSync(`git worktree add -b "${branch}" "${worktreePath}" "${base}"`, execOpts);

    console.log(`[Worker ${workerId}] Worktree ready at ${worktreePath}`);
    return worktreePath;
  } catch (err) {
    console.error(`[Worker ${workerId}] Failed to set up worktree:`, err instanceof Error ? err.message : err);
    // Clean up partial worktree
    try {
      if (existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      execSync('git worktree prune', { ...execOpts, timeout: 5000 });
    } catch {}
    return null;
  }
}

/**
 * Clean up a git worktree after worker completes.
 * Removes the worktree directory and prunes git worktree metadata.
 */
export async function cleanupWorktree(repoPath: string, worktreePath: string, workerId: string) {
  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const execOpts = { cwd: repoPath, timeout: 10000, encoding: 'utf-8' as const };

  try {
    console.log(`[Worker ${workerId}] Removing worktree: ${worktreePath}`);
    execSync(`git worktree remove --force "${worktreePath}"`, execOpts);
  } catch (err) {
    console.warn(`[Worker ${workerId}] git worktree remove failed, cleaning up manually:`, err instanceof Error ? err.message : err);
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      execSync('git worktree prune', execOpts);
    } catch {}
  }
}

/**
 * Collect git stats (commits, files changed, lines added/removed) from a working directory.
 * @param cwd - The working directory to collect stats from
 * @param workerId - For logging
 * @param fallbackCommitCount - Fallback count if git rev-list fails (e.g. from worker.commits.length)
 */
export async function collectGitStats(
  cwd: string | undefined,
  workerId: string,
  fallbackCommitCount?: number,
): Promise<GitStats> {
  if (!cwd) return {};

  const { execSync } = await import('child_process');
  const opts = { cwd, timeout: 5000, encoding: 'utf-8' as const };
  const stats: Record<string, number | string | undefined> = {};

  try {
    stats.lastCommitSha = execSync('git rev-parse HEAD', opts).trim();
  } catch {}
  try {
    // Count commits on this branch vs default branch
    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD@{upstream}', opts).trim().replace(/^origin\//, '') || 'main';
    const count = execSync(`git rev-list --count HEAD ^origin/${defaultBranch}`, opts).trim();
    stats.commitCount = parseInt(count, 10) || 0;
  } catch {
    // Fallback: use locally tracked commits
    if (fallbackCommitCount !== undefined) stats.commitCount = fallbackCommitCount;
  }
  try {
    const numstat = execSync('git diff --numstat HEAD~1 2>/dev/null || true', opts).trim();
    if (numstat) {
      let added = 0, removed = 0, files = 0;
      for (const line of numstat.split('\n')) {
        const [a, r] = line.split('\t');
        if (a !== '-') { added += parseInt(a, 10) || 0; removed += parseInt(r, 10) || 0; files++; }
      }
      stats.filesChanged = files;
      stats.linesAdded = added;
      stats.linesRemoved = removed;
    }
  } catch {}

  return stats;
}
