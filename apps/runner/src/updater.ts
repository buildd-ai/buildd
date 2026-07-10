/**
 * Self-contained auto-update module for the runner.
 *
 * The runner is installed via git sparse checkout to ~/.buildd/ tracking origin/main.
 * This module provides helpers to detect when a newer version is available and
 * to apply the update (git fetch + reset + a clean `bun install`).
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const INSTALL_DIR = process.env.BUILDD_HOME || join(homedir(), '.buildd');
const BRANCH = process.env.BUILDD_BRANCH || 'main';

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
 * Applies the update: git fetch + reset --hard origin/main, then a CLEAN
 * `bun install` (node_modules removed first). Returns a result object; the
 * caller should `process.exit(75)` ONLY on success so the launcher restarts the
 * process. On failure this returns `{ success: false }` WITHOUT exiting, leaving
 * the running process serving from its already-loaded in-memory modules until a
 * later attempt repairs the tree. Every destructive step is inside the single
 * try/catch, so a failure can never throw past this function.
 *
 * Why a clean reinstall (rm + install) instead of a plain `bun install`:
 * bun's isolated store (`node_modules/.bun`) never garbage-collects superseded
 * package versions, so each self-update that bumps a dependency orphans the old
 * version forever — across ALL packages, not just the SDK. In production this
 * grew node_modules to 7.7GB (e.g. 32 versions of @aws-sdk/client-s3) and filled
 * the host disk. Removing node_modules first makes bun rebuild only the
 * lockfile-referenced tree (7.7GB -> 1.8GB observed); installs relink from the
 * warm global cache (`~/.bun/install/cache`) in a few seconds.
 *
 * `installDir`/`fsOps` are injectable purely for unit tests (the runner test
 * suite installs leaky `mock.module('fs', ...)` mocks that would otherwise make
 * the real `rmSync` a no-op); both default to production values.
 */
export function applyUpdate(
  installDir: string = INSTALL_DIR,
  fsOps: Pick<typeof fs, 'rmSync'> = fs,
): UpdateResult {
  const previousCommit = getCurrentCommit();
  const nodeModules = join(installDir, 'node_modules');
  try {
    // Ensure we're on the correct branch before resetting
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: installDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
    }).trim();
    execSync(
      `git fetch origin ${BRANCH}` +
      (currentBranch !== BRANCH ? ` && git checkout -f -B ${BRANCH} origin/${BRANCH}` : '') +
      ` && git reset --hard origin/${BRANCH}`,
      { cwd: installDir, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' },
    );

    // Verify bun is runnable BEFORE deleting node_modules. If bun is missing or
    // broken this throws here (node_modules untouched) rather than after the rm,
    // so a bad bun can never leave the install with a wiped tree it can't rebuild.
    execSync('bun --version', {
      cwd: installDir, encoding: 'utf-8', timeout: 10_000, stdio: 'pipe',
    });

    // Clean reinstall. rm immediately before install to keep the window in which
    // node_modules is absent as small as possible (install is ~seconds from the
    // warm cache). `--frozen-lockfile` fails fast if the freshly-reset bun.lock
    // has drifted from package.json instead of silently mutating the tree.
    fsOps.rmSync(nodeModules, { recursive: true, force: true });

    execSync('bun install --frozen-lockfile', {
      cwd: installDir,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: 'pipe',
    });

    const newCommit = getCurrentCommit();
    return { success: true, previousCommit: previousCommit || undefined, newCommit: newCommit || undefined };
  } catch (err: any) {
    return { success: false, error: err.message || 'Update failed' };
  }
}
