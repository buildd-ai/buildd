/**
 * CBM (codebase-memory-mcp) bootstrap for worker sessions.
 *
 * Before the agent loop starts, the harness runs index_repository via the CBM
 * CLI so the graph is warm on turn one. On timeout or failure the session
 * continues with CBM still mounted but without a pre-indexed cache — the agent
 * can trigger indexing on demand. Indexing failure must never fail the task.
 */

import { rmSync } from 'fs';
import { spawn } from 'child_process';

/** Abort the index build after this many milliseconds. */
export const CBM_INDEX_TIMEOUT_MS = 30_000;

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
  | { ok: false; reason: string; cbmCacheDir: string };

export interface CbmBootstrapOptions {
  worktreePath: string;
  workerId: string;
  serverConfig: CbmServerConfig;
  /** Override the 30-second default for tests. */
  timeoutMs?: number;
  /** Test seam: replace the spawn implementation. */
  spawnProcess?: typeof spawn;
}

/**
 * Run `codebase-memory-mcp cli index_repository <worktreePath>` with a
 * 30-second hard timeout. Returns success with wall-clock duration or failure
 * with a reason string. On failure the caller must proceed with CBM mounted
 * but without a warm cache.
 */
export async function runCbmBootstrap(opts: CbmBootstrapOptions): Promise<CbmBootstrapResult> {
  const {
    worktreePath,
    workerId,
    serverConfig,
    timeoutMs = CBM_INDEX_TIMEOUT_MS,
    spawnProcess = spawn,
  } = opts;

  const cbmCacheDir = `/tmp/cbm-${workerId}`;
  const resolvedEnv = resolveCbmEnv(serverConfig.env, cbmCacheDir, worktreePath);
  const start = Date.now();

  return new Promise<CbmBootstrapResult>(resolve => {
    let settled = false;

    const child = spawnProcess(
      serverConfig.command,
      ['cli', 'index_repository', worktreePath],
      {
        env: { ...process.env, ...resolvedEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      try { rmSync(cbmCacheDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      resolve({ ok: false, reason: `timeout after ${timeoutMs}ms`, cbmCacheDir });
    }, timeoutMs);

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message, cbmCacheDir });
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (code === 0) {
        resolve({ ok: true, durationMs, cbmCacheDir });
      } else {
        try { rmSync(cbmCacheDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        resolve({ ok: false, reason: `process exited with code ${code}`, cbmCacheDir });
      }
    });
  });
}
