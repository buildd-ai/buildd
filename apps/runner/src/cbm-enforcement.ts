/**
 * Codebase Memory (CBM) enforcement — default-on MCP for repo-backed Claude tasks.
 *
 * CBM is enforced across all roles rather than added per-role by hand.
 * A role can opt out by setting mcpServers['codebase-memory'] = false in its
 * skill DB record; the claim route reads this and sends cbmDisabled=true on the
 * claimed worker payload.
 *
 * Degradation rules:
 *   - Codex tasks: skipped (CBM is Claude-only)
 *   - No worktree (coordination workspaces, service roles): skipped — nothing to index
 *   - Role opted out (cbmDisabled): skipped
 *   - Binary absent from image: skipped silently (existsSync guard)
 */

import { join } from 'path';

import { CBM_BINARY_PATH } from './bwrap-mount-allowlist';

/**
 * Tools the CBM server must NOT expose to the agent.
 * delete_project and ingest_traces are destructive; manage_adr writes ADR files
 * into the codebase — an unwanted side effect from an indexing tool.
 */
export const CBM_BLOCKED_TOOLS = [
  'mcp__codebase-memory__delete_project',
  'mcp__codebase-memory__manage_adr',
  'mcp__codebase-memory__ingest_traces',
] as const;

/**
 * Exact set of CBM tools the agent is allowed to use.
 * Listed here for documentation; enforcement is via CBM_BLOCKED_TOOLS (blocklist).
 */
export const CBM_ALLOWED_TOOLS = [
  'search_graph',
  'trace_path',
  'detect_changes',
  'query_graph',
  'get_graph_schema',
  'get_code_snippet',
  'get_architecture',
  'search_code',
  'index_repository',
  'index_status',
  'list_projects',
  'check_index_coverage',
] as const;

export interface CbmContext {
  workerId: string;
  /** Absolute path of the worker's git worktree (undefined when no repo checkout). */
  worktreePath: string | undefined;
  isCodexTask: boolean;
  /** True when the role's DB record has mcpServers['codebase-memory'] === false. */
  cbmRoleDisabled: boolean;
  /** Injectable for testing; defaults to existsSync in production. */
  pathExists?: (path: string) => boolean;
}

export interface CbmActivation {
  enforced: boolean;
  cbmBinaryPath?: string;
  cbmCacheDir?: string;
  /** Per-worker daemon runtime dir; see cbmRuntimeDirFor. */
  cbmRuntimeDir?: string;
}

/**
 * Where CBM puts its coordination socket for this worker.
 *
 * CBM 0.10.x routes every process (MCP server, CLI, hooks) through a per-user
 * daemon discovered via this directory, and refuses to start when an active
 * daemon holds a *different* CBM_CACHE_DIR:
 *   "CBM could not start because the active account daemon uses a different
 *    cache directory"
 * Because each worker gets its own cache dir, two workers running concurrently
 * on one host would fight over the account and only the first would get CBM.
 * Verified against 0.10.8 in the worker image: the second concurrent `mcp`
 * server exits 1 without this, and exits 0 with it.
 *
 * Nested inside the cache dir so the sandbox already binds it rw and cleanup
 * removes it with the cache. Keep it short: the daemon's unix socket lives
 * under this path and must fit in sun_path (108 bytes on Linux).
 */
export function cbmRuntimeDirFor(cbmCacheDir: string): string {
  return join(cbmCacheDir, 'run');
}

/**
 * Create the runtime dir with mode 0700. CBM checks the permissions of this
 * directory and refuses a looser one with "secure CLI coordination could not be
 * created (endpoint)" — a group-readable 0755 dir is enough to trip it.
 */
export function ensureCbmRuntimeDir(cbmCacheDir: string): string {
  // Required lazily: 26 runner test files replace 'fs' with a partial mock.module
  // stub, and a static named import of a function they omit fails the whole file
  // at parse time ("Export named 'chmodSync' not found in module 'node:fs'").
  const { chmodSync, mkdirSync } = require('fs') as typeof import('fs');
  const dir = cbmRuntimeDirFor(cbmCacheDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // recursive:true ignores `mode` for a directory that already exists.
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Determine whether CBM should be active for this worker.
 * Returns enforced=true with the binary path and cache dir when all gates pass.
 * Pure function — does NOT create the cache dir (caller must mkdir before bwrap mount).
 */
export function buildCbmActivation(ctx: CbmContext): CbmActivation {
  const pathExists = ctx.pathExists ?? ((p: string) => {
    const { existsSync } = require('fs') as typeof import('fs');
    return existsSync(p);
  });
  const enforced = !ctx.isCodexTask && !!ctx.worktreePath && !ctx.cbmRoleDisabled && pathExists(CBM_BINARY_PATH);
  if (!enforced) return { enforced: false };
  const cbmCacheDir = `/tmp/cbm-${ctx.workerId}`;
  return {
    enforced: true,
    cbmBinaryPath: CBM_BINARY_PATH,
    cbmCacheDir,
    cbmRuntimeDir: cbmRuntimeDirFor(cbmCacheDir),
  };
}

/**
 * Build the SDK mcpServers entry for the codebase-memory server.
 * Returns a stdio entry with all required env vars resolved to concrete values.
 */
export function buildCbmMcpEntry(sessionCwd: string, cbmCacheDir: string) {
  return {
    type: 'stdio' as const,
    command: CBM_BINARY_PATH,
    args: ['mcp'],
    env: {
      CBM_CACHE_DIR: cbmCacheDir,
      CBM_RUNTIME_DIR: cbmRuntimeDirFor(cbmCacheDir),
      CBM_ALLOWED_ROOT: sessionCwd,
      CBM_AUTO_WATCH: 'false',
      // Soft memory hint (not a hard RSS cap). Measured buildd RSS: 650-800 MB at 512; raised to 1024.
      CBM_MEM_BUDGET_MB: '1024',
    },
  };
}

/** The three metric buckets a session can land in. Mirrors CbmMetrics.outcome. */
export type CbmOutcome = 'enforced' | 'legacy_mcp_json' | 'disabled';

/**
 * Final CBM classification for the metrics.
 *
 * `mounted` is whether the session's FINAL `mcpServers` map carries a
 * `codebase-memory` entry. That is only knowable after connector and project
 * `.mcp.json` injection, so the caller resolves this late in session startup
 * rather than at activation time.
 *
 * Why `legacy_mcp_json` matters: a session the harness did not enforce but that
 * has CBM mounted some other way still HAS the graph tools. Recording it as
 * `disabled` put a CBM-equipped session in the metrics control group, which
 * flattens the exact comparison the metrics exist to make. Before this the
 * declared `legacy_mcp_json` value was never assigned by any code path.
 */
export function resolveCbmOutcome(input: { enforced: boolean; mounted: boolean }): CbmOutcome {
  if (input.enforced) return 'enforced';
  return input.mounted ? 'legacy_mcp_json' : 'disabled';
}
