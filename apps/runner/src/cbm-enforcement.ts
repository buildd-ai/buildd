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
  /** Absolute path of the base clone the worktree belongs to — the path a shared seed is indexed at. */
  repoPath?: string;
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
  /** True when cbmCacheDir is the host-wide seeded cache rather than a per-worker one. */
  sharedCache?: boolean;
  /** True when the graph is already warm, so the per-task index would be wasted work. */
  skipBootstrapIndex?: boolean;
  /** CBM project key the seed is indexed under (shared mode only). */
  cbmProject?: string;
}

/**
 * Host-wide seeded cache dir. Deliberately NOT under ~/.buildd: that is the
 * runner's git clone, and install.sh runs `git reset --hard` in it.
 */
export function sharedCbmCacheDir(): string {
  const { homedir } = require('os') as typeof import('os');
  return process.env.BUILDD_CBM_SHARED_CACHE || join(homedir(), '.buildd-cbm-cache');
}

/**
 * CBM's project key for a repo path.
 *
 * CBM keys a project by the absolute path it was indexed at, slugified — verified
 * against 0.10.8: /Users/max/buildd -> "Users-max-buildd", /home/coder/base ->
 * "home-coder-base", and the db lands at <cache>/<key>.db. This is what makes a
 * seed non-portable: point the same cache at a different path and CBM indexes a
 * second project at full cost. If this derivation is ever wrong the seed lookup
 * simply misses and the caller falls back to a per-worker index — a safe failure.
 */
export function cbmProjectNameFor(repoPath: string): string {
  return repoPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/[^A-Za-z0-9]+/g, '-');
}

/** Per-worker daemon runtime dir for shared mode — must live outside the shared cache. */
function sharedModeRuntimeDir(workerId: string): string {
  return `/tmp/cbm-rt-${workerId}`;
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
export function ensureCbmRuntimeDir(cbmCacheDir: string, explicitDir?: string): string {
  // Required lazily: 26 runner test files replace 'fs' with a partial mock.module
  // stub, and a static named import of a function they omit fails the whole file
  // at parse time ("Export named 'chmodSync' not found in module 'node:fs'").
  const { chmodSync, mkdirSync } = require('fs') as typeof import('fs');
  const dir = explicitDir ?? cbmRuntimeDirFor(cbmCacheDir);
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
export function buildCbmSystemPromptBlock(opts: { project?: string; sharedBaseIndex?: boolean } = {}): string {
  // Shared mode indexes the base clone, not this worktree, so the graph maps the
  // repo as of the seed and get_code_snippet serves that copy (verified against
  // 0.10.8: an edit made in the worktree does not appear in the snippet).
  // Structure is accurate; file contents on this branch are not — say so rather
  // than let the agent trust a snippet of a file it just edited.
  const opening = opts.sharedBaseIndex
    ? [
        'This repo is already indexed in the `codebase-memory` MCP server as project `'
          + (opts.project ?? 'unknown') + '` — the graph is warm before your first turn, with no indexing to wait for.',
        'It maps the base checkout, not your branch: trust it for structure, and Read the file for current content'
          + ' — especially anything you have edited this session.',
      ]
    : ['This worktree is already indexed in the `codebase-memory` MCP server — the graph is warm before your first turn.'];
  return [
    '## Codebase graph (codebase-memory)',
    ...opening,
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

  // Prefer a seed already built for this repo: the graph is warm, so the per-task
  // index (~20s cold, ~11s warm) is pure waste. Requires a db for THIS repo path —
  // a seed for another repo is worthless, since the project key is the path.
  if (ctx.repoPath) {
    const shared = sharedCbmCacheDir();
    const project = cbmProjectNameFor(ctx.repoPath);
    if (pathExists(shared) && pathExists(join(shared, `${project}.db`))) {
      return {
        enforced: true,
        cbmBinaryPath: CBM_BINARY_PATH,
        cbmCacheDir: shared,
        cbmRuntimeDir: sharedModeRuntimeDir(ctx.workerId),
        sharedCache: true,
        skipBootstrapIndex: true,
        cbmProject: project,
      };
    }
  }

  const cbmCacheDir = `/tmp/cbm-${ctx.workerId}`;
  return {
    enforced: true,
    cbmBinaryPath: CBM_BINARY_PATH,
    cbmCacheDir,
    cbmRuntimeDir: cbmRuntimeDirFor(cbmCacheDir),
  };
}

/**
 * Kick off a shared-cache refresh for a repo, out of band.
 *
 * Deliberately fire-and-forget and detached: seeding costs ~20s, so doing it on the
 * worker's critical path would reintroduce exactly the rampup this replaces. The
 * current worker uses whatever seed exists today (or falls back to a per-worker
 * index); the next one gets the fresh graph. The script itself is idempotent — it
 * stamps the indexed HEAD and exits immediately when it has not moved — and
 * concurrent seeds are safe (verified at 0.10.8: two simultaneous
 * index_repository writers into one cache dir both succeed with integrity intact).
 *
 * Deduped per repo per process so a burst of claims does not spawn a burst of
 * indexers; the HEAD stamp covers the cross-process case.
 */
const seedRefreshRequested = new Set<string>();

export function spawnCbmSeedRefresh(
  repoPath: string,
  deps: {
    spawnProcess?: typeof import('child_process').spawn;
    pathExists?: (p: string) => boolean;
    scriptPath?: string;
    runtime?: string;
  } = {},
): boolean {
  const pathExists = deps.pathExists ?? ((p: string) => {
    const { existsSync } = require('fs') as typeof import('fs');
    return existsSync(p);
  });
  if (!repoPath || !pathExists(CBM_BINARY_PATH)) return false;
  if (seedRefreshRequested.has(repoPath)) return false;

  const script = deps.scriptPath ?? join(import.meta.dir, '..', 'scripts', 'cbm-seed.ts');
  if (!pathExists(script)) return false;

  seedRefreshRequested.add(repoPath);
  try {
    const spawn = deps.spawnProcess ?? (require('child_process') as typeof import('child_process')).spawn;
    const child = spawn(deps.runtime ?? process.execPath, [script, repoPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref?.();
    return true;
  } catch {
    // A failed refresh must never affect the worker — it just means no seed yet.
    seedRefreshRequested.delete(repoPath);
    return false;
  }
}

/** Test seam: forget which repos have already been asked to refresh. */
export function resetCbmSeedRefreshState(): void {
  seedRefreshRequested.clear();
}

/**
 * Build the SDK mcpServers entry for the codebase-memory server.
 * Returns a stdio entry with all required env vars resolved to concrete values.
 */
export function buildCbmMcpEntry(sessionCwd: string, cbmCacheDir: string, cbmRuntimeDir?: string) {
  return {
    type: 'stdio' as const,
    command: CBM_BINARY_PATH,
    args: ['mcp'],
    env: {
      CBM_CACHE_DIR: cbmCacheDir,
      CBM_RUNTIME_DIR: cbmRuntimeDir ?? cbmRuntimeDirFor(cbmCacheDir),
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
