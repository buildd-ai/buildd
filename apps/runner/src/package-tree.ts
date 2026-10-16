/**
 * The runner's installed packages, as the updater and the boot preflight see
 * them. Node built-ins only: the preflight runs before any package is
 * resolvable, so this file must never import one.
 *
 * Background (task c08b35ae). `apps/runner/node_modules/*` are bun symlinks into
 * the root `node_modules/.bun` store. An update that deleted the root
 * `node_modules` and then failed to reinstall left every one of them dangling,
 * and each restart died on `ENOENT reading ".../pusher-js"` before any runner
 * code ran. Two rules follow, and both live here so they cannot drift apart:
 *
 *   1. Never delete the working package tree before its replacement exists.
 *      `stageAside` renames it, `discardAside` drops it after a good install,
 *      `restoreAside` puts it back after a bad one.
 *   2. "Missing" means unresolvable, not "directory absent": a dangling symlink
 *      is missing.
 */
import * as nodeFs from 'fs';
import { join } from 'path';

export type TreeFs = Pick<typeof nodeFs, 'existsSync' | 'renameSync' | 'rmSync' | 'readdirSync' | 'readFileSync' | 'writeFileSync'>;

/** Suffix of the previous tree while a replacement install is in flight. */
export const ASIDE_SUFFIX = '.buildd-prev';

/** Every `node_modules` directory a root `bun install` writes for the runner's checkout. */
export function packageRoots(installDir: string, fs: TreeFs = nodeFs): string[] {
  const roots = [join(installDir, 'node_modules'), join(installDir, 'apps', 'runner', 'node_modules')];
  try {
    for (const d of fs.readdirSync(join(installDir, 'packages'))) {
      roots.push(join(installDir, 'packages', String(d), 'node_modules'));
    }
  } catch { /* sparse or absent: nothing to add */ }
  return roots;
}

/**
 * Runner dependencies that cannot be resolved. `existsSync` follows symlinks, so
 * a dangling link reports as missing, which is exactly the failure mode.
 */
export function findMissingPackages(installDir: string, fs: TreeFs = nodeFs): string[] {
  let deps: string[];
  try {
    const pkg = JSON.parse(String(fs.readFileSync(join(installDir, 'apps', 'runner', 'package.json'), 'utf-8')));
    deps = Object.keys(pkg.dependencies ?? {});
  } catch {
    return []; // not a runner checkout we can judge; do not block boot on it
  }
  const missing: string[] = [];
  for (const dep of deps) {
    const here = join(installDir, 'apps', 'runner', 'node_modules', dep, 'package.json');
    const hoisted = join(installDir, 'node_modules', dep, 'package.json');
    if (!fs.existsSync(here) && !fs.existsSync(hoisted)) missing.push(dep);
  }
  return missing;
}

/** Bound on one dependency install. A cold cache on a slow link needs minutes, a hang needs an end. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Written for the whole of an updater install, removed when it ends. While it
 * names a live process and is younger than the install bound, the half-built
 * tree is that process's work in progress, not an interrupted swap: a second
 * launch (`buildd --help`, a launchd restart of a sibling) must neither restore
 * `*.buildd-prev` underneath it nor start a repair install of its own.
 */
export const INSTALL_LOCK_FILE = '.buildd-install.lock';
/** The install bound plus a minute for staging and restore around it. */
export const INSTALL_LOCK_MAX_AGE_MS = INSTALL_TIMEOUT_MS + 60_000;

export interface LockProbe {
  now?: () => number;
  /** True when `pid` is a running process. */
  isAlive?: (pid: number) => boolean;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; }
}

/** Mark an install as running in this process. Best effort: a failed write only loses the guard. */
export function acquireInstallLock(installDir: string, fs: TreeFs = nodeFs, now: () => number = Date.now, pid = process.pid): void {
  try { fs.writeFileSync(join(installDir, INSTALL_LOCK_FILE), JSON.stringify({ pid, startedAt: now() })); } catch { /* guard only */ }
}

export function releaseInstallLock(installDir: string, fs: TreeFs = nodeFs): void {
  try { fs.rmSync(join(installDir, INSTALL_LOCK_FILE), { force: true }); } catch { /* guard only */ }
}

/**
 * The pid of another process whose install is still in flight, or null. A lock
 * whose pid is dead, or older than the install bound (pid reuse, a clock jump),
 * is stale and ignored. The caller's own pid never counts.
 */
export function installInProgress(installDir: string, fs: TreeFs = nodeFs, probe: LockProbe = {}): number | null {
  const now = probe.now ?? Date.now;
  const isAlive = probe.isAlive ?? pidAlive;
  let lock: { pid?: unknown; startedAt?: unknown };
  try { lock = JSON.parse(String(fs.readFileSync(join(installDir, INSTALL_LOCK_FILE), 'utf-8'))); } catch { return null; }
  const pid = Number(lock.pid);
  const startedAt = Number(lock.startedAt);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !Number.isFinite(startedAt)) return null;
  if (now() - startedAt > INSTALL_LOCK_MAX_AGE_MS) return null;
  return isAlive(pid) ? pid : null;
}

export interface StagedTree { dir: string; aside: string }

/**
 * Move the current package directories out of the way. All-or-nothing: if one
 * rename fails, the ones already moved go back and the error is rethrown.
 */
export function stageAside(installDir: string, fs: TreeFs = nodeFs): StagedTree[] {
  const staged: StagedTree[] = [];
  try {
    for (const dir of packageRoots(installDir, fs)) {
      if (!fs.existsSync(dir)) continue;
      const aside = dir + ASIDE_SUFFIX;
      fs.rmSync(aside, { recursive: true, force: true }); // a leftover from a killed update
      fs.renameSync(dir, aside);
      staged.push({ dir, aside });
    }
  } catch (err) {
    restoreAside(staged, fs);
    throw err;
  }
  return staged;
}

/** Throw the partial replacement away and put the previous tree back. */
export function restoreAside(staged: StagedTree[], fs: TreeFs = nodeFs): void {
  for (const { dir, aside } of staged) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(aside, dir);
  }
}

/** The replacement installed; the previous tree can go. Best effort. */
export function discardAside(staged: StagedTree[], fs: TreeFs = nodeFs): void {
  for (const { aside } of staged) {
    try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* disk reclaim only */ }
  }
}

/**
 * An update killed between `stageAside` and its outcome leaves `*.buildd-prev`
 * directories. Where the live directory is gone, put the previous one back;
 * where both exist the install finished and the leftover is garbage. Does
 * nothing while a live install holds `INSTALL_LOCK_FILE`.
 * Returns the directories restored.
 */
export function recoverInterruptedSwap(installDir: string, fs: TreeFs = nodeFs, probe: LockProbe = {}): string[] {
  const restored: string[] = [];
  // Not interrupted: another process is mid-install and owns both trees.
  if (installInProgress(installDir, fs, probe) !== null) return restored;
  // A live tree that cannot resolve is a half-finished install: the previous one wins.
  const liveBroken = findMissingPackages(installDir, fs).length > 0;
  for (const dir of packageRoots(installDir, fs)) {
    const aside = dir + ASIDE_SUFFIX;
    if (!fs.existsSync(aside)) continue;
    try {
      if (!fs.existsSync(dir) || liveBroken) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(aside, dir);
        restored.push(dir);
      } else fs.rmSync(aside, { recursive: true, force: true });
    } catch { /* leave it for the next pass */ }
  }
  return restored;
}
