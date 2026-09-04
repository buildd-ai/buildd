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

import type { CbmMetrics } from './types.js';
import { join } from 'path';

import { CBM_BINARY_PATH } from './bwrap-mount-allowlist';

/**
 * Deny decision over a classified tool surface: everything on the surface that is
 * not explicitly allowed is blocked, MCP-prefixed for `disallowedTools`.
 */
export function deriveCbmBlockedTools(
  surface: readonly string[],
  allowed: readonly string[],
): string[] {
  const allowedSet = new Set(allowed);
  return surface.filter(tool => !allowedSet.has(tool)).map(tool => `mcp__codebase-memory__${tool}`);
}

/**
 * The CBM tools this runner has classified — the 15 tools recorded for
 * codebase-memory-mcp in docs/design/codebase-memory-mcp-integration.md §2.4.
 *
 * This is the set the deny decision below is computed over — NOT a guarantee that
 * the pinned build exposes nothing else. A tool CBM adds in a later release is unknown
 * here and therefore reaches the agent unblocked; `disallowedTools` is a
 * blocklist, so deny-by-default is not expressible through it. Bumping the CBM
 * pin means re-reading its tool list and classifying any new entry here.
 */
export const CBM_TOOL_SURFACE = [
  // read / query — safe for the agent
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
  // destructive / side-effecting — must not reach the agent
  'delete_project',
  'manage_adr',
  'ingest_traces',
] as const;

/**
 * Exact set of CBM tools the agent is allowed to use.
 * Everything else on the classified surface is blocked (see CBM_BLOCKED_TOOLS).
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

/**
 * Tools the CBM server must NOT expose to the agent — derived, so that adding a
 * tool to CBM_TOOL_SURFACE without allowing it blocks it automatically.
 * delete_project and ingest_traces are destructive; manage_adr writes ADR files
 * into the codebase — an unwanted side effect from an indexing tool.
 */
export const CBM_BLOCKED_TOOLS: readonly string[] = deriveCbmBlockedTools(CBM_TOOL_SURFACE, CBM_ALLOWED_TOOLS);

/**
 * Append the CBM blocklist to a session's disallowedTools.
 *
 * Apply this unconditionally. The previous call site ran only when the runner
 * itself had put `codebase-memory` into queryOptions.mcpServers, which misses
 * every other way the server can reach the agent — most concretely a stdio entry
 * in the project's `.mcp.json`, which the SDK loads on its own via
 * settingSources: ['user', 'project'] and which the runner's .mcp.json injection
 * skips because it only handles `type: 'http'`. On that path the destructive
 * tools were fully exposed. Naming a tool that is not mounted is inert, so there
 * is no cost to always blocking these.
 */
export function applyCbmToolBlocklist(existing: readonly string[] | undefined): string[] {
  return [...new Set([...(existing ?? []), ...CBM_BLOCKED_TOOLS])];
}

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
 * Is this path the ROOT of a git repo?
 *
 * "Is it a git repo" is the wrong question: git answers from the nearest enclosing
 * repo, so any subdirectory passes. On the live fleet the runner handed the seeder
 * `/home/coder/.buildd/roles/builder` — a role config dir inside the runner's own
 * checkout — and a plain repo check resolved origin/main from ~/.buildd and seeded
 * an entire duplicate graph under a key nothing wanted. (The version before that
 * indexed the directory itself: 821 MB of cache for a config folder.)
 */
export function isGitRepoRoot(
  repoPath: string,
  runGit?: (args: string[], cwd: string) => { ok: boolean; out: string },
): boolean {
  const { resolve } = require('path') as typeof import('path');
  const run = runGit ?? ((args: string[], cwd: string) => {
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000 });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
  });
  const top = run(['rev-parse', '--show-toplevel'], repoPath);
  if (!top.ok || !top.out) return false;
  return resolve(top.out) === resolve(repoPath.replace(/\/+$/, ''));
}

/**
 * Root for dedicated seed checkouts.
 *
 * A seed must be indexed from a checkout that tracks the repo's default branch.
 * The base clone cannot serve: the runner only ever adds worktrees to it, so its
 * HEAD stays on whatever leftover worker branch was checked out last — measured 98
 * commits behind origin/main on the live fleet — and never moves, which also meant
 * a HEAD-stamped refresh could never re-fire.
 */
export function cbmSeedRoot(): string {
  const { homedir } = require('os') as typeof import('os');
  return process.env.BUILDD_CBM_SEED_ROOT || join(homedir(), '.buildd-cbm-seed');
}

/** Stable, readable, collision-free seed path for a repo. */
export function cbmSeedPathFor(repoPath: string): string {
  const { createHash } = require('crypto') as typeof import('crypto');
  const { basename } = require('path') as typeof import('path');
  const normalized = repoPath.replace(/\/+$/, '');
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 12);
  return join(cbmSeedRoot(), `${basename(normalized) || 'repo'}-${hash}`);
}

export interface CbmSeedRecord {
  repoPath: string;
  seedPath: string;
  /** Project name CBM itself reported — never derived. See below. */
  project: string;
  /** Ref the seed checkout tracks, e.g. "origin/main". */
  ref: string;
  /** Commit the seed was indexed at, so a refresh can tell when it moved. */
  sha: string;
  indexedAt: string;
}

/**
 * Where the seed record for a repo lives.
 *
 * Keyed by a hash of the repo path so a record can be found without guessing
 * CBM's slug rules.
 */
function seedRecordPath(repoPath: string): string {
  const { createHash } = require('crypto') as typeof import('crypto');
  const hash = createHash('sha1').update(repoPath.replace(/\/+$/, '')).digest('hex').slice(0, 16);
  return join(sharedCbmCacheDir(), 'seeds', `${hash}.json`);
}

/**
 * Record what the seeder actually produced.
 *
 * The project name is READ FROM CBM's own output rather than derived from the
 * path. CBM's slug keeps dots — `/home/coder/.buildd-cbm-seed/buildd-abc123`
 * becomes `home-coder-.buildd-cbm-seed-buildd-abc123` — which a
 * replace-non-alphanumerics derivation silently collapsed, and a wrong key fails
 * as "project not found or not indexed" at query time, on the agent's turn, with
 * no signal at activation. Recording the fact removes the guess entirely.
 */
export function writeCbmSeedRecord(repoPath: string, record: CbmSeedRecord): void {
  const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs');
  const path = seedRecordPath(repoPath);
  mkdirSync(join(sharedCbmCacheDir(), 'seeds'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

export function readCbmSeedRecord(repoPath: string): CbmSeedRecord | null {
  const { existsSync, readFileSync } = require('fs') as typeof import('fs');
  const path = seedRecordPath(repoPath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CbmSeedRecord;
    return parsed && typeof parsed.project === 'string' ? parsed : null;
  } catch {
    return null; // corrupt record: fall back to a per-worker index
  }
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
  // index (~20s cold, ~11s warm, worse under concurrency) is pure waste.
  //
  // The seed is looked up through its record, not by deriving a key from the repo
  // path. Deriving matched a db indexed from the BASE CLONE, whose checkout tracks
  // a stale leftover branch — that is the bug this replaces.
  if (ctx.repoPath) {
    const shared = sharedCbmCacheDir();
    const record = readCbmSeedRecord(ctx.repoPath);
    if (record && pathExists(join(shared, `${record.project}.db`))) {
      return {
        enforced: true,
        cbmBinaryPath: CBM_BINARY_PATH,
        cbmCacheDir: shared,
        cbmRuntimeDir: sharedModeRuntimeDir(ctx.workerId),
        sharedCache: true,
        skipBootstrapIndex: true,
        cbmProject: record.project,
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
const seedRefreshAttempts = new Map<string, number>();

/**
 * Every reason a refresh did not spawn, as a value the caller can log.
 *
 * This used to be a bare `boolean` that the single call site discarded. Combined
 * with a detached child on `stdio: 'ignore'`, that made the entire seed path
 * unobservable: the seed script has eight distinct non-zero exits and not one of
 * them could reach an operator. The fleet ran with role-scoped workers getting no
 * seed at all and the only visible trace was an indirect one — `bootstrapResult`
 * never reading `skipped_warm` for those workers.
 */
export type SeedRefreshOutcome =
  | 'spawned'
  | 'no_repo_path'
  | 'binary_absent'
  | 'script_absent'
  | 'recently_attempted'
  | 'spawn_failed';

/**
 * How long a repo is left alone after an attempt.
 *
 * Replaces a permanent per-process latch. The latch was added so a burst of
 * claims could not spawn a burst of indexers, and it did that — but it was set
 * BEFORE the spawn and cleared only if `spawn` itself threw, so a seeder that
 * started and then failed marked the repo done forever. The runner process is
 * long-lived, so "forever" meant until someone restarted it, with no log line to
 * say why the seed never appeared. A cooldown gives the same burst protection
 * and still converges.
 */
export const SEED_RETRY_COOLDOWN_MS = 10 * 60_000;

/**
 * Where the detached seeder's own output goes.
 *
 * Under the shared cache dir rather than the runner's log, because it is the
 * shared cache's provenance: "why is there no seed for this repo" is answered
 * here, next to the seed records themselves.
 */
export function cbmSeedLogPath(): string {
  return join(sharedCbmCacheDir(), 'logs', 'seed.log');
}

function openSeedLogFd(): number | null {
  try {
    const { mkdirSync, openSync } = require('fs') as typeof import('fs');
    const { dirname } = require('path') as typeof import('path');
    const path = cbmSeedLogPath();
    mkdirSync(dirname(path), { recursive: true });
    return openSync(path, 'a');
  } catch {
    return null; // no log is survivable; a crashed worker is not
  }
}

export function spawnCbmSeedRefresh(
  repoPath: string,
  deps: {
    spawnProcess?: typeof import('child_process').spawn;
    pathExists?: (p: string) => boolean;
    scriptPath?: string;
    runtime?: string;
    now?: () => number;
    openLogFd?: () => number | null;
  } = {},
): SeedRefreshOutcome {
  const pathExists = deps.pathExists ?? ((p: string) => {
    const { existsSync } = require('fs') as typeof import('fs');
    return existsSync(p);
  });
  const now = deps.now ?? (() => Date.now());

  if (!repoPath) return 'no_repo_path';
  if (!pathExists(CBM_BINARY_PATH)) return 'binary_absent';

  const lastAttempt = seedRefreshAttempts.get(repoPath);
  if (lastAttempt !== undefined && now() - lastAttempt < SEED_RETRY_COOLDOWN_MS) {
    return 'recently_attempted';
  }

  const script = deps.scriptPath ?? join(import.meta.dir, '..', 'scripts', 'cbm-seed.ts');
  if (!pathExists(script)) return 'script_absent';

  seedRefreshAttempts.set(repoPath, now());
  try {
    const spawn = deps.spawnProcess ?? (require('child_process') as typeof import('child_process')).spawn;
    const logFd = (deps.openLogFd ?? openSeedLogFd)();
    const child = spawn(deps.runtime ?? process.execPath, [script, repoPath], {
      detached: true,
      // stdin closed, stdout+stderr to the seed log. Was 'ignore', which threw
      // away the only description of why a seed did not happen.
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
    });
    // The refresh is still fire-and-forget — nothing awaits this — but a failed
    // seeder must not hold the cooldown, or one early failure suppresses every
    // later attempt for the life of the process.
    child.on?.('exit', (code: number | null) => {
      if (code !== 0) {
        seedRefreshAttempts.delete(repoPath);
        console.warn(`[cbm-seed] seeder for ${repoPath} exited ${code} — see ${cbmSeedLogPath()}`);
      }
    });
    child.unref?.();
    return 'spawned';
  } catch {
    // A failed refresh must never affect the worker — it just means no seed yet.
    seedRefreshAttempts.delete(repoPath);
    return 'spawn_failed';
  }
}

/** Test seam: forget which repos have already been asked to refresh. */
export function resetCbmSeedRefreshState(): void {
  seedRefreshAttempts.clear();
}

/**
 * Assemble the per-task CBM metrics that travel to the server in `resultMeta.cbm`.
 *
 * Extracted from the completion path so it is testable directly. The unit test
 * used to carry its own hand-copied "simulates what workers.ts does" version,
 * which cannot fail when a real field is added or dropped — and a field that was
 * computed but never emitted (`sharedCache`) is precisely how the shared cache's
 * hit rate stayed invisible.
 */
export function buildCbmMetrics(worker: {
  cbmOutcome?: CbmMetrics['outcome'];
  cbmDisableReason?: CbmMetrics['disableReason'];
  cbmBootstrapResult?: CbmMetrics['bootstrapResult'];
  cbmBootstrapFailReason?: string;
  cbmSharedCache?: boolean;
  cbmSeedRefresh?: SeedRefreshOutcome;
  cbmToolCounts?: Record<string, number>;
  cbmFileAccessCounts?: { read: number; grep: number; glob: number };
}): CbmMetrics | undefined {
  if (worker.cbmOutcome === undefined) return undefined;
  const cbmCounts = worker.cbmToolCounts ?? {};
  const fileAccess = worker.cbmFileAccessCounts ?? { read: 0, grep: 0, glob: 0 };
  return {
    outcome: worker.cbmOutcome,
    ...(worker.cbmDisableReason && { disableReason: worker.cbmDisableReason }),
    ...(worker.cbmBootstrapResult && { bootstrapResult: worker.cbmBootstrapResult }),
    ...(worker.cbmBootstrapFailReason && { bootstrapFailReason: worker.cbmBootstrapFailReason }),
    // Always emitted, including false: "this task did NOT get the seed" is the
    // finding, so it has to be a value in the row and not an absent key.
    sharedCache: !!worker.cbmSharedCache,
    ...(worker.cbmSeedRefresh && { seedRefresh: worker.cbmSeedRefresh }),
    toolCalls: cbmCounts,
    totalCbmCalls: Object.values(cbmCounts).reduce((s, n) => s + n, 0),
    readCount: fileAccess.read,
    grepCount: fileAccess.grep,
    globCount: fileAccess.glob,
  };
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
