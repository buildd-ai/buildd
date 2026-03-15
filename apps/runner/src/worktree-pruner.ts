/**
 * Worktree pruner — cleans up orphaned git worktrees from crashed workers,
 * e2e tests, and runner restarts.
 *
 * Two modes:
 * 1. Startup: `git worktree prune` + remove dirs with no active worker
 * 2. Periodic: remove worktrees older than retention that don't belong to active workers
 */

import { existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const WORKTREE_DIR = '.buildd-worktrees';

/** Worker statuses that indicate the worker is still active and its worktree should be kept */
const ACTIVE_STATUSES = new Set(['working', 'waiting', 'stale']);

/** Default retention period for completed worker worktrees (24 hours) */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface WorktreePruneOptions {
  /** Map of worktree directory names to worker status (from local worker store) */
  activeWorkers: Map<string, { status: string; worktreePath?: string }>;
  /** Retention period in ms for completed worker worktrees */
  retentionMs?: number;
  /** Current timestamp (for testing) */
  now?: number;
}

/**
 * Run `git worktree prune` to clean up worktrees whose directories were already deleted.
 * Safe to run anytime — only removes git metadata for missing directories.
 */
export function gitWorktreePrune(repoPath: string): void {
  try {
    execSync('git worktree prune', {
      cwd: repoPath,
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    console.warn(`[WorktreePruner] git worktree prune failed in ${repoPath}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Get the set of worktree directory names that are associated with active workers.
 * A worktree is "active" if its worker is in working, waiting, or stale status.
 */
function getActiveWorktreeDirs(activeWorkers: WorktreePruneOptions['activeWorkers']): Set<string> {
  const dirs = new Set<string>();
  for (const [, worker] of activeWorkers) {
    if (ACTIVE_STATUSES.has(worker.status) && worker.worktreePath) {
      // Extract the directory name from the full worktree path
      const parts = worker.worktreePath.split('/');
      const dirName = parts[parts.length - 1];
      if (dirName) dirs.add(dirName);
    }
  }
  return dirs;
}

/**
 * Get the set of ALL worktree directory names that have a worker record (any status).
 * Used for startup pruning — only remove dirs that have NO worker record at all.
 */
function getAllWorkerWorktreeDirs(activeWorkers: WorktreePruneOptions['activeWorkers']): Set<string> {
  const dirs = new Set<string>();
  for (const [, worker] of activeWorkers) {
    if (worker.worktreePath) {
      const parts = worker.worktreePath.split('/');
      const dirName = parts[parts.length - 1];
      if (dirName) dirs.add(dirName);
    }
  }
  return dirs;
}

/**
 * Startup pruning: remove worktree directories that have no corresponding worker record.
 * These are fully orphaned — from crashed workers, e2e tests, etc.
 *
 * Does NOT remove worktrees that have a worker record (even completed ones) —
 * those are handled by periodic cleanup with retention.
 */
export function pruneOrphanedWorktrees(
  repoPath: string,
  activeWorkers: WorktreePruneOptions['activeWorkers'],
): number {
  const worktreeBase = join(repoPath, WORKTREE_DIR);
  if (!existsSync(worktreeBase)) return 0;

  const knownDirs = getAllWorkerWorktreeDirs(activeWorkers);
  let removed = 0;

  let entries: string[];
  try {
    entries = readdirSync(worktreeBase);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (knownDirs.has(entry)) continue;

    const fullPath = join(worktreeBase, entry);
    try {
      const stat = statSync(fullPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // No worker record for this directory — it's orphaned
    try {
      console.log(`[WorktreePruner] Removing orphaned worktree: ${fullPath}`);
      removeWorktree(repoPath, fullPath);
      removed++;
    } catch (err) {
      console.warn(`[WorktreePruner] Failed to remove orphaned worktree ${fullPath}:`, err instanceof Error ? err.message : err);
    }
  }

  return removed;
}

/**
 * Periodic pruning: remove worktrees for completed/failed workers past the retention period.
 * Only removes worktrees for workers in done/error status (not working/waiting/stale).
 * Also removes any fully orphaned worktrees (no worker record) regardless of age.
 */
export function pruneExpiredWorktrees(
  repoPath: string,
  options: WorktreePruneOptions,
): number {
  const worktreeBase = join(repoPath, WORKTREE_DIR);
  if (!existsSync(worktreeBase)) return 0;

  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const now = options.now ?? Date.now();
  const activeDirs = getActiveWorktreeDirs(options.activeWorkers);
  const allKnownDirs = getAllWorkerWorktreeDirs(options.activeWorkers);
  let removed = 0;

  let entries: string[];
  try {
    entries = readdirSync(worktreeBase);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    // Never remove active worker worktrees
    if (activeDirs.has(entry)) continue;

    const fullPath = join(worktreeBase, entry);
    let stat;
    try {
      stat = statSync(fullPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Fully orphaned (no worker record) — always remove
    if (!allKnownDirs.has(entry)) {
      try {
        console.log(`[WorktreePruner] Removing orphaned worktree: ${fullPath}`);
        removeWorktree(repoPath, fullPath);
        removed++;
      } catch (err) {
        console.warn(`[WorktreePruner] Failed to remove orphaned worktree ${fullPath}:`, err instanceof Error ? err.message : err);
      }
      continue;
    }

    // Has a worker record but not active — check retention
    const age = now - stat.mtimeMs;
    if (age > retentionMs) {
      try {
        console.log(`[WorktreePruner] Removing expired worktree (${Math.round(age / 3600000)}h old): ${fullPath}`);
        removeWorktree(repoPath, fullPath);
        removed++;
      } catch (err) {
        console.warn(`[WorktreePruner] Failed to remove expired worktree ${fullPath}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return removed;
}

/**
 * Remove a single worktree — tries `git worktree remove` first, falls back to rm + prune.
 */
function removeWorktree(repoPath: string, worktreePath: string): void {
  const execOpts = { cwd: repoPath, timeout: 10_000, encoding: 'utf-8' as const, stdio: 'pipe' as const };

  try {
    execSync(`git worktree remove --force "${worktreePath}"`, execOpts);
  } catch {
    // Fallback: force-remove directory and prune git metadata
    rmSync(worktreePath, { recursive: true, force: true });
    try {
      execSync('git worktree prune', execOpts);
    } catch {}
  }
}

/**
 * Full startup prune sequence:
 * 1. Run `git worktree prune` to clean stale git metadata
 * 2. Remove orphaned worktree directories with no worker record
 */
export function startupPrune(
  repoPath: string,
  activeWorkers: WorktreePruneOptions['activeWorkers'],
): void {
  console.log(`[WorktreePruner] Running startup prune for ${repoPath}`);
  gitWorktreePrune(repoPath);
  const removed = pruneOrphanedWorktrees(repoPath, activeWorkers);
  if (removed > 0) {
    console.log(`[WorktreePruner] Startup: removed ${removed} orphaned worktree(s)`);
    // Prune git metadata again after removing directories
    gitWorktreePrune(repoPath);
  }
}

/**
 * Full periodic prune sequence:
 * 1. Run `git worktree prune` to clean stale git metadata
 * 2. Remove expired and orphaned worktree directories
 */
export function periodicPrune(
  repoPath: string,
  options: WorktreePruneOptions,
): void {
  gitWorktreePrune(repoPath);
  const removed = pruneExpiredWorktrees(repoPath, options);
  if (removed > 0) {
    console.log(`[WorktreePruner] Periodic: removed ${removed} expired/orphaned worktree(s)`);
    gitWorktreePrune(repoPath);
  }
}
