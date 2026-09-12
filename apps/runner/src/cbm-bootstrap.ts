/**
 * CBM (codebase-memory-mcp) bootstrap for worker sessions.
 *
 * Before the agent loop starts, the harness runs index_repository via the CBM
 * CLI so the graph is warm on turn one. The harness WAITS for that build only
 * up to a budget; when the budget expires the build carries on in the
 * background and the session starts without waiting for it. Failure — and slowness
 * — must never fail the task.
 */

import { rmSync } from 'fs';
import { spawn } from 'child_process';

import { cbmRuntimeDirFor, ensureCbmRuntimeDir } from './cbm-enforcement';

/**
 * How long worker startup WAITS for the index build before handing it off.
 *
 * Not a timeout on the build — a budget on the wait. Nothing is aborted when it
 * expires; see runCbmBootstrap.
 *
 * Left at 60s deliberately. An uncontended build of a repo this size lands
 * inside it (0.9.0 did it in ~10s; 0.10.x rebuilt the pipeline and adds a daemon
 * cold start, measured in the tens of seconds in the worker image). The builds
 * that overran the old deadline were the CONTENDED ones — several workers
 * indexing the same repo on one host at once — and raising the number only moves
 * where the abort lands. Now that expiry is a hand-off rather than a kill, the
 * value stops being a cliff, so it did not need re-tuning as part of the fix.
 */
export const CBM_INDEX_WAIT_MS = 60_000;

/**
 * Fleet-tunable wait budget, so the startup/warmth trade-off can be moved
 * without cutting a runner release.
 *
 * A bad value falls back to the default rather than being honoured: `0` would
 * background every build on the fleet, which is too large a behaviour change to
 * reach via a typo in an env var.
 */
export function resolveCbmIndexWaitMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.BUILDD_CBM_INDEX_WAIT_MS;
  if (!raw) return CBM_INDEX_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return CBM_INDEX_WAIT_MS;
  return parsed;
}

export interface CbmServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Merge CBM env overrides into the base server env, substituting
 * __WORKSPACE_DIR__ placeholders with the actual worktree path.
 */
function resolveCbmEnv(
  baseEnv: Record<string, string>,
  cbmCacheDir: string,
  worktreePath: string,
): Record<string, string> {
  const merged: Record<string, string> = {
    ...baseEnv,
    CBM_CACHE_DIR: cbmCacheDir,
    // Per-worker daemon coordination dir — see cbmRuntimeDirFor.
    CBM_RUNTIME_DIR: cbmRuntimeDirFor(cbmCacheDir),
    CBM_ALLOWED_ROOT: worktreePath,
    CBM_AUTO_WATCH: 'false',
    // Soft memory hint (not a hard RSS cap). Measured buildd RSS: 650-800 MB at 512; raised to 1024.
    CBM_MEM_BUDGET_MB: '1024',
  };
  for (const [key, val] of Object.entries(merged)) {
    merged[key] = val.replace(/__WORKSPACE_DIR__/g, worktreePath);
  }
  return merged;
}

export type CbmBootstrapResult =
  | { ok: true; durationMs: number; cbmCacheDir: string }
  | {
      ok: false;
      reason: string;
      cbmCacheDir: string;
      /**
       * True when the wait budget expired and the build was handed off rather
       * than failing. The index is still being built; the cache dir is intact.
       *
       * A distinct field, not a reason string, because the two cases need
       * opposite handling: a real failure means there will be no graph, a
       * hand-off means there will be one shortly.
       */
      backgrounded?: boolean;
    };

/** Outcome of a build that finished after the wait budget had already expired. */
export interface CbmLateCompletion {
  ok: boolean;
  /** Wall clock from spawn to exit — the build's real cost, which the wait hides. */
  durationMs: number;
  reason?: string;
}

export interface CbmBootstrapOptions {
  worktreePath: string;
  workerId: string;
  serverConfig: CbmServerConfig;
  /** Override the wait budget (tests, and the env-tuned production value). */
  timeoutMs?: number;
  /** Test seam: replace the spawn implementation. */
  spawnProcess?: typeof spawn;
  /**
   * Called if the build was handed off and then finished on its own.
   *
   * This is what keeps the metric honest. Without it every overrunning build is
   * recorded as "backgrounded" forever and nothing says whether backgrounding
   * actually delivers a graph — which would make the headline index-build number
   * improve by relabelling rather than by working.
   *
   * Never called for a build that finished inside the budget (the return value
   * already says so) nor for one ended by stopBackgroundCbmIndex (a deliberate
   * teardown is not a build outcome).
   */
  onLateCompletion?: (result: CbmLateCompletion) => void;
}

/**
 * Backgrounded indexers, by worker id.
 *
 * Module-level because the owner of this process is the session loop in
 * workers.ts, which needs to end the indexer at teardown — it removes the
 * per-worker cache dir, and an indexer still writing into a deleted directory is
 * pure waste plus a core the next task's build wants.
 */
const backgroundIndexers = new Map<string, { stop: () => void }>();

/**
 * End the backgrounded index for a worker, if one is still running.
 *
 * Returns whether there was anything to stop. Idempotent: session teardown runs
 * in a `finally` that can be reached more than once.
 */
export function stopBackgroundCbmIndex(workerId: string): boolean {
  const handle = backgroundIndexers.get(workerId);
  if (!handle) return false;
  backgroundIndexers.delete(workerId);
  handle.stop();
  return true;
}

/**
 * Drop a cache dir whose build crashed, then put the daemon coordination dir back.
 *
 * ONLY for a build that exited non-zero. CBM_RUNTIME_DIR lives inside the cache
 * dir and CBM refuses to start at all when it is missing ("secure daemon endpoint
 * could not be created", verified against 0.10.8), so the caller — which mounts
 * CBM regardless of what happens here — would otherwise get no CBM at all rather
 * than a cold one.
 *
 * Not called when the wait budget expires. That path used to come through here
 * and it was destroying a live build's working state for no benefit: 0.10.8
 * indexes into `<project>.db.stage.XXXXXX` and renames it into place at the end,
 * so an interrupted build never leaves a queryable `.db` to salvage in the first
 * place — the deletion was cleaning up after a kill that itself was the problem.
 */
function discardCache(cbmCacheDir: string): void {
  try { rmSync(cbmCacheDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { ensureCbmRuntimeDir(cbmCacheDir); } catch { /* best-effort */ }
}

/**
 * Run `codebase-memory-mcp cli index_repository --repo-path <worktreePath>`,
 * waiting at most `timeoutMs` for it.
 *
 * Three outcomes:
 *   - `ok: true` — the build finished inside the budget; the graph is warm.
 *   - `ok: false, backgrounded: true` — the budget expired. The build KEEPS
 *     RUNNING, the cache dir is left alone, and the session starts now. The
 *     graph appears in the agent's already-connected MCP session when the build
 *     publishes (verified against 0.10.8: a server started against an empty
 *     cache dir picks up a project indexed into that dir afterwards, with no
 *     restart). `onLateCompletion` reports what the build eventually did.
 *   - `ok: false` — the build genuinely failed (spawn error or non-zero exit).
 *
 * Why the budget no longer aborts: CBM has no server-side request timeout, so
 * every "timeout" recorded here was this client killing a build that was still
 * making progress, and 0.10.8's atomic publish meant the killed build left
 * nothing behind. That turned one slow build into a session with no graph at
 * all — and per-worker cache dirs are fresh, so the next task paid the same cost
 * again. Handing the build off costs nothing and keeps its result.
 *
 * `--repo-path` is required. A bare trailing positional is parsed as raw JSON
 * args (checked on 0.9.0 and 0.10.8), so it never populates repo_path: the index
 * worker exits 1 with `repo_path is required` in its own log, while the server
 * reports the misleading `"Indexing worker crashed on a file"`. That mismatch made
 * this look like a bad source file rather than an argv bug.
 *
 * No `--mode` is passed, so CBM's default applies.
 */
export async function runCbmBootstrap(opts: CbmBootstrapOptions): Promise<CbmBootstrapResult> {
  const {
    worktreePath,
    workerId,
    serverConfig,
    timeoutMs = resolveCbmIndexWaitMs(),
    spawnProcess = spawn,
    onLateCompletion,
  } = opts;

  const cbmCacheDir = `/tmp/cbm-${workerId}`;
  // The daemon needs its 0700 coordination dir to exist before the first command.
  try { ensureCbmRuntimeDir(cbmCacheDir); } catch { /* best-effort; CBM reports the failure */ }
  const resolvedEnv = resolveCbmEnv(serverConfig.env, cbmCacheDir, worktreePath);
  const start = Date.now();

  return new Promise<CbmBootstrapResult>(resolve => {
    // `settled` = the WAIT is over. It no longer implies the child is over, which
    // is the whole change: the close/error handlers below still run afterwards and
    // report the build's real outcome.
    let settled = false;
    let backgrounded = false;
    let stopped = false;

    const child = spawnProcess(
      serverConfig.command,
      ['cli', 'index_repository', '--repo-path', worktreePath],
      {
        env: { ...process.env, ...resolvedEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      backgrounded = true;
      backgroundIndexers.set(workerId, {
        stop: () => {
          stopped = true;
          try { child.kill('SIGTERM'); } catch { /* already gone */ }
        },
      });
      // Let the runner's event loop forget about it; the handle above is how we
      // keep control of it.
      child.unref?.();
      resolve({
        ok: false,
        backgrounded: true,
        reason: `still indexing after ${timeoutMs}ms — continuing in the background`,
        cbmCacheDir,
      });
    }, timeoutMs);

    child.on('error', (err: Error) => {
      if (settled) {
        if (backgrounded && !stopped) {
          backgroundIndexers.delete(workerId);
          onLateCompletion?.({ ok: false, durationMs: Date.now() - start, reason: err.message });
        }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message, cbmCacheDir });
    });

    child.on('close', (code: number | null) => {
      const durationMs = Date.now() - start;
      if (settled) {
        // The wait already returned. Only a BACKGROUNDED build has an outcome to
        // report here, and only if we did not end it ourselves — a teardown kill
        // is not a failed build.
        if (backgrounded && !stopped) {
          backgroundIndexers.delete(workerId);
          onLateCompletion?.(
            code === 0
              ? { ok: true, durationMs }
              : { ok: false, durationMs, reason: `process exited with code ${code}` },
          );
        }
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, durationMs, cbmCacheDir });
      } else {
        discardCache(cbmCacheDir);
        resolve({ ok: false, reason: `process exited with code ${code}`, cbmCacheDir });
      }
    });
  });
}
