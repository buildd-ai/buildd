/**
 * Self-contained auto-update module for the runner.
 *
 * The runner is installed via git sparse checkout to ~/.buildd/ tracking origin/main.
 * This module provides helpers to detect when a newer version is available and
 * to apply the update (git fetch + reset + bun install).
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

/**
 * Extracts the store version-dir segment immediately after `/.bun/` in a path.
 * e.g. `.../node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.3.201/node_modules/...`
 *   -> `@anthropic-ai+claude-agent-sdk@0.3.201`
 */
function bunStoreSegment(p: string): string | null {
  const parts = p.split('/');
  const i = parts.lastIndexOf('.bun');
  if (i === -1 || i + 1 >= parts.length) return null;
  return parts[i + 1] || null;
}

/**
 * Prunes stale `@anthropic-ai/claude-agent-sdk` version directories from bun's
 * isolated store (`<installDir>/node_modules/.bun`).
 *
 * bun's isolated store never garbage-collects superseded versions, so every SDK
 * bump carried by a self-update orphans the previous ~230MB native binary. Left
 * unchecked this fills the host disk and wedges the runner mid-`bun install`.
 *
 * Keep-set (validated in production):
 *   1. For each live symlink at `<installDir>/{apps,packages}/*\/node_modules/
 *      @anthropic-ai/claude-agent-sdk` that resolves, keep the store version dir
 *      it points into (the path segment right after `.bun/`).
 *   2. For each kept version dir, keep the store dirs its native-binary deps
 *      resolve into (the separate `-linux-arm64@X` / `-musl@X` packages under
 *      `<store>/<versionDir>/node_modules/@anthropic-ai/*`).
 *
 * Then delete every `<store>/*claude-agent-sdk*` dir whose basename is NOT in the
 * keep-set. If the keep-set comes out empty (nothing resolved) nothing is deleted,
 * so a broken/half-installed tree is never nuked.
 *
 * `fsOps` is injectable purely so unit tests can pass a real `fs` (the runner test
 * suite installs leaky `mock.module('fs', ...)` mocks); it defaults to real `fs`.
 */
type PruneFsOps = Pick<typeof fs, 'existsSync' | 'readdirSync' | 'realpathSync' | 'rmSync'>;

export function pruneStaleSdkVersions(
  installDir: string = INSTALL_DIR,
  fsOps: PruneFsOps = fs,
): { pruned: string[]; kept: string[] } {
  const store = join(installDir, 'node_modules', '.bun');
  if (!fsOps.existsSync(store)) return { pruned: [], kept: [] };

  const keep = new Set<string>();

  // 1. Live app/package sdk symlinks -> their store version dir (+ native deps).
  for (const group of ['apps', 'packages']) {
    let members: string[];
    try {
      members = fsOps.readdirSync(join(installDir, group));
    } catch {
      continue; // group dir absent — skip
    }
    for (const member of members) {
      const link = join(installDir, group, member, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
      let real: string;
      try {
        real = fsOps.realpathSync(link); // resolves the symlink chain; throws if target is missing
      } catch {
        continue; // not a live/resolvable link
      }
      const seg = bunStoreSegment(real);
      if (!seg) continue;
      keep.add(seg);

      // 2. Native-binary deps referenced by this version dir.
      const depsDir = join(store, seg, 'node_modules', '@anthropic-ai');
      let deps: string[];
      try {
        deps = fsOps.readdirSync(depsDir);
      } catch {
        continue;
      }
      for (const dep of deps) {
        try {
          const depSeg = bunStoreSegment(fsOps.realpathSync(join(depsDir, dep)));
          if (depSeg) keep.add(depSeg);
        } catch {
          // dangling dep symlink — ignore
        }
      }
    }
  }

  // Safety: nothing resolved — refuse to delete (broken/half-installed tree).
  if (keep.size === 0) return { pruned: [], kept: [] };

  const pruned: string[] = [];
  for (const entry of fsOps.readdirSync(store)) {
    if (!entry.includes('claude-agent-sdk')) continue; // scope strictly to the SDK
    if (keep.has(entry)) continue;
    fsOps.rmSync(join(store, entry), { recursive: true, force: true });
    pruned.push(entry);
  }

  return { pruned, kept: [...keep] };
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
    // Ensure we're on the correct branch before resetting
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALL_DIR, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
    }).trim();
    execSync(
      `git fetch origin ${BRANCH}` +
      (currentBranch !== BRANCH ? ` && git checkout -f -B ${BRANCH} origin/${BRANCH}` : '') +
      ` && git reset --hard origin/${BRANCH}`,
      { cwd: INSTALL_DIR, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' },
    );

    execSync('bun install', {
      cwd: INSTALL_DIR,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: 'pipe',
    });

    // Prune superseded SDK versions from bun's isolated store. bun never GCs old
    // versions, so each SDK bump orphans a ~230MB binary — best-effort only: a
    // prune failure must never fail the update (caller relies on success -> exit 75).
    try {
      const { pruned } = pruneStaleSdkVersions(INSTALL_DIR);
      if (pruned.length > 0) {
        console.log(`[updater] pruned ${pruned.length} stale SDK store dir(s): ${pruned.join(', ')}`);
      }
    } catch (err: any) {
      console.error(`[updater] SDK store prune failed (non-fatal): ${err?.message || err}`);
    }

    const newCommit = getCurrentCommit();
    return { success: true, previousCommit: previousCommit || undefined, newCommit: newCommit || undefined };
  } catch (err: any) {
    return { success: false, error: err.message || 'Update failed' };
  }
}
