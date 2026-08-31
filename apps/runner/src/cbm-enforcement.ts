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
 * Create the runtime dir, not world-writable.
 *
 * Measured against 0.10.8, CBM's actual requirements are: the dir must EXIST
 * (missing → "secure daemon endpoint could not be created"), and it must be owned
 * by the caller and not world-writable (0777 → "not a usable private-directory
 * parent"). 0755 is accepted; 0700 is simply the tightest mode that qualifies, so
 * that is what we create — but the invariant worth guarding is existence, which is
 * why the bootstrap restores this dir after it discards a failed cache.
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
 * System-prompt block appended for CBM-enforced sessions.
 *
 * Lives here (not inline in workers.ts) so the wording is testable: production
 * data showed essentially every CBM-enforced worker indexing successfully and then
 * making zero graph calls, so this text is the thing under test, not decoration.
 *
 * The previous version listed the tools and the question shapes they answer, which
 * is a capability list — the agent read it, then reached for Grep anyway, because
 * Grep answers well enough that the graph never gets consulted. The fix is
 * procedural and ordered: on a task that touches code you have not read yet, the
 * FIRST navigation call is a graph call. It stays scoped (greenfield files and
 * docs edits have no structural question) and stays non-blocking (Read/Grep remain
 * available, and the graph is explicitly an accelerator, never a gate).
 */
export function buildCbmSystemPromptBlock(): string {
  return [
    '## Codebase graph (codebase-memory)',
    'This worktree is already indexed in the `codebase-memory` MCP server — the graph is warm before your first turn.',
    '',
    'When a task touches existing code you have not read yet, make a graph call your FIRST navigation step,',
    'before any Read/Grep/Glob sweep. One call is usually enough to know where to look:',
    '- orienting in an unfamiliar area, or "how is this laid out?" -> mcp__codebase-memory__get_architecture',
    '- "what calls X?" / "call chain from A to B?" -> mcp__codebase-memory__trace_path',
    '- "what breaks if I change X?" (dependents, blast radius) -> mcp__codebase-memory__search_graph',
    '- locating a symbol before reading it -> mcp__codebase-memory__search_code, then get_code_snippet',
    '',
    'Then use Read/Grep/Glob to read what the graph located, for non-code files, for a greenfield file that',
    'does not exist yet, and whenever the graph returns nothing useful — it is an accelerator, never a gate.',
    'A Grep-and-Read sweep that a single graph query would have answered is the specific waste to avoid.',
    'If a query reports the project is not indexed, call mcp__codebase-memory__index_repository once.',
    '',
    'The graph answers structural questions ONLY. It is not a source of intent, history, or prior',
    'decisions — use the buildd knowledge tools (recall) for those.',
  ].join('\n');
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
