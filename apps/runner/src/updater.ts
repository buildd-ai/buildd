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
import { readFileSync } from 'fs';

const INSTALL_DIR = process.env.BUILDD_HOME || join(homedir(), '.buildd');
const BRANCH = process.env.BUILDD_BRANCH || 'main';

// Read once at module load from package.json (updated by release script + CI).
// Shared by index.ts (local console/API display) and workers.ts (heartbeat
// payload) so both report the same value without a circular import between them.
export const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
})();

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
 * True when the on-disk HEAD no longer matches the commit the running
 * process loaded at startup (or after its last successful self-update).
 * This is the exact signature of an external process — self-heal's
 * `fixGitBranch`, a host-level `git reset --hard` — rewriting the install's
 * tree without restarting the long-lived runner process, so its in-memory
 * modules keep serving stale code indefinitely.
 */
export function hasCommitDrift(diskCommit: string | null, processCommit: string | null): boolean {
  return !!diskCommit && !!processCommit && diskCommit !== processCommit;
}

/**
 * Decide whether an update should be surfaced/applied given a runner-relevant
 * changelog. An empty changelog normally means "no runner-code changes in
 * this release" — but on a shallow clone (`git clone --depth 1`), a truncated
 * commit range can look empty for a reason that has nothing to do with the
 * release content. When the changelog can't be trusted (`reliable: false`),
 * default to treating the update as available rather than silently skipping
 * it — a redundant sync is cheap; a missed one leaves the runner stale.
 */
export function shouldShowUpdateAvailable(changelogEntries: string[], changelogReliable: boolean): boolean {
  return changelogEntries.length > 0 || !changelogReliable;
}

/**
 * Returns true when the working tree has modified or staged **tracked** files.
 * Untracked files are intentionally excluded (`--untracked-files=no`): runtime
 * artifacts (config.json, history.db, workers/, roles/, repos-cache.json, etc.)
 * live alongside the tracked checkout without being committed, so any git reset
 * --hard is safe regardless of their presence. Only real edits to tracked files
 * should block an update.
 */
export function hasTrackedChanges(installDir: string = INSTALL_DIR): boolean {
  try {
    const status = execSync('git status --porcelain --untracked-files=no', {
      cwd: installDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return status.length > 0;
  } catch {
    // If git can't run, assume clean — the subsequent git fetch will fail too.
    return false;
  }
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

/**
 * How long `updateState.updating` may stay set before we treat the update path
 * as wedged rather than slow. A real update — fetch, reset, `bun install`,
 * restart — completes in well under a minute; ten is generous enough that a
 * slow install is never mistaken for a hang.
 */
export const UPDATE_STUCK_LIMIT_MS = 10 * 60_000;

/**
 * Has the `updating` flag been set so long that the update path must be stuck?
 *
 * This matters because `updating` gates BOTH the auto-updater and the drift
 * check (`hasCommitDrift`). Every code path that sets it either exits the
 * process or clears it in a catch — but only for failures that *throw*. An
 * `await` that hangs without throwing would leave the flag set forever and
 * silence both mechanisms at once: the working tree moves on, the process keeps
 * its old modules, and nothing logs.
 *
 * **This guard was originally built on a misreading of that symptom.** The
 * attempts-without-outcomes it was written to explain were not hangs at all —
 * the health probe could never pass, so every attempt rolled the tree back and
 * returned through a path that logged nothing (see buildHealthProbeSpawn). The
 * giveaway was the timing: those attempts landed on *consecutive* 60s ticks,
 * and a hung update holds `updating` and blocks the next tick entirely. One
 * attempt per tick means each one was completing, quietly.
 *
 * Keep the watchdog regardless — it is cheap, and an unbounded `await` in the
 * update path really would present this way — but do not read a stuck flag as
 * the explanation for a stale runner without checking the tick spacing first.
 *
 * Returns false when `updatingSince` is null so an un-instrumented caller can
 * never trigger a spurious unwedge.
 */
export function isUpdateStuck(
  updating: boolean,
  updatingSince: number | null,
  now: number,
  limitMs: number = UPDATE_STUCK_LIMIT_MS,
): boolean {
  if (!updating || updatingSince === null) return false;
  return now - updatingSince >= limitMs;
}

/**
 * The runner entry path, **exactly as the launcher invokes it** — relative to
 * the install dir, which the launcher makes its cwd:
 *
 *     cd ~/.buildd && bun run apps/runner/src/index.ts
 *
 * The health probe has to reuse both halves of that, and the cwd is the
 * load-bearing one. Bun reads `bunfig.toml` from the cwd only; it does not walk
 * up to the repo root (see `packages/core/bunfig.toml`, which exists solely
 * because of that). The root bunfig preloads `scripts/stub-server-only.ts`, and
 * without it any transitive import of the DB layer hits `server-only`'s
 * unconditional throw at module load.
 *
 * So a probe launched from `<install>/apps/runner` — which carries no bunfig —
 * crashes before it can bind a port. It did exactly that in production: every
 * attempt "failed" its health check in about a second, reset the tree back to
 * the previous commit, and left the fleet pinned to stale code with nothing
 * logged.
 */
export const RUNNER_ENTRY = 'apps/runner/src/index.ts';

/**
 * Where the probe is pointed instead of the real coordination server.
 *
 * The probe boots a complete runner holding the real credentials. Aimed at the
 * live server it registers and starts claiming, then gets killed seconds later,
 * orphaning whatever it claimed. Port 1 is reserved (tcpmux) and never
 * listening, so registration fails fast and the probe still proves what it is
 * there to prove: the module graph loads and the HTTP server binds.
 */
export const HEALTH_PROBE_SERVER = 'http://127.0.0.1:1';

export interface HealthProbeSpawn {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * How the freshly-updated code is booted to decide whether to restart into it.
 *
 * Split out as a pure function because the whole defect lived in these three
 * values (cwd, entry, env) and nothing else — a probe asserted only through its
 * boolean outcome is indistinguishable from one that can never pass.
 */
export function buildHealthProbeSpawn(opts: {
  installDir: string;
  probePort: number;
  /** Isolated BUILDD_HOME: worker state, worktrees and the repos cache live here. */
  probeHome: string;
  /** The real config file — shared on purpose, so the real boot path is what gets validated. */
  configFile: string;
  baseEnv?: Record<string, string | undefined>;
}): HealthProbeSpawn {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.baseEnv ?? {})) {
    // Bun.spawn's env is Record<string, string>; an inherited undefined would
    // otherwise reach the child as the literal string "undefined".
    if (typeof v === 'string') env[k] = v;
  }
  env.PORT = String(opts.probePort);
  env.BUILDD_HOME = opts.probeHome;
  env.BUILDD_CONFIG = opts.configFile;
  env.BUILDD_SERVER = HEALTH_PROBE_SERVER;

  return {
    // --debug is explicit: the HTTP server only exists in debug mode, and a
    // probe with no server to answer would read as an unhealthy build.
    cmd: ['bun', 'run', RUNNER_ENTRY, '--debug'],
    cwd: opts.installDir,
    env,
  };
}

/** Attempts allowed against one target commit before auto-update gives up on it. */
export const AUTO_UPDATE_RETRY_LIMIT = 3;

/**
 * Is there budget left to attempt an auto-update to `targetCommit`?
 *
 * The budget is keyed to the commit it was spent against, not to a state
 * transition. It used to be reset in exactly one place — the `updateAvailable`
 * false -> true edge — but a runner that is already stale has that flag set, so
 * a *newer* release arriving never re-armed it. Three failures therefore
 * disabled auto-update permanently until someone restarted the process by hand.
 *
 * A null `targetCommit` cannot refill anything: an unknown target on every tick
 * would make the limit meaningless.
 */
export function hasAutoUpdateBudget(
  retriesSpent: number,
  spentAgainstCommit: string | null,
  targetCommit: string | null,
  limit: number = AUTO_UPDATE_RETRY_LIMIT,
): boolean {
  if (targetCommit !== null && spentAgainstCommit !== targetCommit) return true;
  return retriesSpent < limit;
}
