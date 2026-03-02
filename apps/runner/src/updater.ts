/**
 * Self-contained auto-update module for the runner.
 *
 * The runner is installed via git sparse checkout to ~/.buildd/ tracking origin/main.
 * This module provides helpers to detect when a newer version is available and
 * to apply the update (git fetch + reset + bun install).
 */

import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const INSTALL_DIR = join(homedir(), '.buildd');

/** Returns the current HEAD commit SHA of the local installation. */
export function getCurrentCommit(): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: INSTALL_DIR,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** Simple SHA inequality check — returns true when an update is available. */
export function checkForUpdate(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  return current !== latest;
}

export interface UpdateResult {
  success: boolean;
  error?: string;
  previousCommit?: string;
  newCommit?: string;
}

/**
 * Applies the update: git fetch + reset --hard origin/main + bun install.
 * Returns a result object. The caller should `process.exit(75)` on success
 * so the launcher script restarts the process.
 */
export function applyUpdate(): UpdateResult {
  const previousCommit = getCurrentCommit();
  try {
    execSync('git fetch origin main && git reset --hard origin/main', {
      cwd: INSTALL_DIR,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: 'pipe',
    });

    execSync('bun install', {
      cwd: INSTALL_DIR,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: 'pipe',
    });

    const newCommit = getCurrentCommit();
    return { success: true, previousCommit: previousCommit || undefined, newCommit: newCommit || undefined };
  } catch (err: any) {
    return { success: false, error: err.message || 'Update failed' };
  }
}
