/**
 * Git operations for worker sessions — worktree setup/cleanup and stats collection.
 * Extracted from WorkerManager to reduce workers.ts complexity.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveWorktreeBase, BranchFetchResult } from './worktree-utils';

export interface GitStats {
  commitCount?: number;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  lastCommitSha?: string;
}

/**
 * Install workspace dependencies into a freshly-created worktree so Bun's nested
 * node_modules symlinks (@buildd/core, @buildd/shared, …) exist locally — without
 * them, deep imports like '@buildd/core/db' fail with "Cannot find module".
 *
 * Runs ASYNCHRONOUSLY (execFile, not execSync): even a warm-cache install takes a
 * few seconds, and a synchronous call would freeze the runner's single event loop
 * for the whole duration — starving heartbeats, the 30s stale-check and the 10s
 * server sync, which can get an active worker wrongly flagged stale.
 *
 * `--frozen-lockfile` keeps the common path fast and deterministic (no re-resolution,
 * no lockfile mutation). If the branch's lockfile has drifted, frozen install fails,
 * so we retry unfrozen — node_modules gets created either way. Both attempts are
 * non-fatal: a total failure only warns (deep @buildd/* imports may then break, and
 * the caller falls back to the main repo).
 */
async function installWorkspaceDeps(worktreePath: string, workerId: string): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const run = promisify(execFile);
  const opts = { cwd: worktreePath, timeout: 120_000, encoding: 'utf-8' as const };

  console.log(`[Worker ${workerId}] Running bun install in worktree (frozen lockfile)...`);
  try {
    await run('bun', ['install', '--frozen-lockfile'], opts);
    console.log(`[Worker ${workerId}] Workspace packages linked`);
    return;
  } catch (err) {
    console.warn(
      `[Worker ${workerId}] Frozen bun install failed (lockfile may have drifted), retrying unfrozen:`,
      err instanceof Error ? err.message : err,
    );
  }

  try {
    await run('bun', ['install'], opts);
    console.log(`[Worker ${workerId}] Workspace packages linked (unfrozen)`);
  } catch (err) {
    console.warn(
      `[Worker ${workerId}] bun install in worktree failed — @buildd/* imports may break:`,
      err instanceof Error ? err.message : err,
    );
  }
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

    // Warn if parent repo has sparse checkout enabled. Git worktrees get their
    // own sparse-checkout config so this doesn't directly affect the worktree,
    // but it's worth logging so the pattern is visible if issues recur.
    try {
      const sparsePatterns = execSync('git sparse-checkout list', { ...execOpts, timeout: 5000 }).trim();
      if (sparsePatterns) {
        console.warn(
          `[Worker ${workerId}] Parent repo has sparse checkout enabled. ` +
          `Worktrees are always fully checked out, but if @buildd/* imports still fail, ` +
          `run: cd "${repoPath}" && git sparse-checkout disable && bun install`,
        );
      }
    } catch {
      // Non-zero exit means sparse checkout is not configured — normal state.
    }

    // Create worktree with new branch — from resumeBranch/baseBranch (retry) or default branch (fresh)
    // fetchBranch uses already-fetched remote tracking refs (git fetch origin ran above)
    const fetchBranch = async (candidate: string): Promise<BranchFetchResult> => {
      try {
        const countStr = execSync(
          `git rev-list --count "origin/${defaultBranch}..origin/${candidate}"`,
          { ...execOpts, timeout: 10000 },
        ).trim();
        const count = parseInt(countStr, 10);
        if (!isNaN(count) && count > 50) {
          return 'diverged';
        }
        return 'ok';
      } catch {
        // Command fails when origin/<candidate> ref doesn't exist
        return 'missing';
      }
    };
    const base = await resolveWorktreeBase({
      defaultBranch,
      context: taskContext,
      fetchBranch,
      log: (msg) => console.log(`[Worker ${workerId}] ${msg}`),
    });
    console.log(`[Worker ${workerId}] Creating worktree: ${worktreePath} (branch: ${branch}, base: ${base})`);
    execSync(`git worktree add -b "${branch}" "${worktreePath}" "${base}"`, execOpts);

    // Register the repo's shared git hooks in this worktree. The package.json
    // `prepare` script also sets this during `bun install`, but that install is
    // best-effort (see installWorkspaceDeps) — doing it explicitly here guarantees
    // commit-time gates (e.g. spec lint) fire even if install never runs. Guarded
    // on .githooks existing so other repos the runner clones are unaffected.
    if (existsSync(join(worktreePath, '.githooks'))) {
      try {
        execSync('git config core.hooksPath .githooks', { ...execOpts, cwd: worktreePath });
        console.log(`[Worker ${workerId}] Registered .githooks (core.hooksPath)`);
      } catch (err) {
        console.warn(`[Worker ${workerId}] Failed to register .githooks:`, err instanceof Error ? err.message : err);
      }
    }

    // Wire up workspace package symlinks (@buildd/core, @buildd/shared, etc.).
    // Bun places these in nested node_modules (e.g. apps/web/node_modules/@buildd/core)
    // rather than the workspace root. A fresh worktree has no node_modules at all, so
    // module resolution from the worktree tree never finds the symlinks that exist in the
    // parent repo — causing '@buildd/core/db' (and similar deep imports) to fail with
    // "Cannot find module". Running bun install creates the links in-place.
    await installWorkspaceDeps(worktreePath, workerId);

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
    // Compute full PR diff: find the merge-base with the base branch so we capture all
    // commits on this branch, not just the last commit (HEAD~1 only shows the final commit).
    // Try branch candidates in order; the first one that yields a merge-base wins.
    let mergeBase = '';
    for (const candidate of ['origin/dev', 'origin/main', 'origin/master']) {
      try {
        const result = execSync(`git merge-base HEAD ${candidate} 2>/dev/null`, opts).trim();
        if (result) { mergeBase = result; break; }
      } catch {}
    }
    const diffTarget = mergeBase || 'HEAD~1';
    const numstat = execSync(`git diff --numstat ${diffTarget} 2>/dev/null || true`, opts).trim();
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
