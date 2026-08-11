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
  return {
    enforced: true,
    cbmBinaryPath: CBM_BINARY_PATH,
    cbmCacheDir: `/tmp/cbm-${ctx.workerId}`,
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
      CBM_ALLOWED_ROOT: sessionCwd,
      CBM_AUTO_WATCH: 'false',
      // Soft memory hint (not a hard RSS cap). Measured buildd RSS: 650-800 MB at 512; raised to 1024.
      CBM_MEM_BUDGET_MB: '1024',
    },
  };
}
