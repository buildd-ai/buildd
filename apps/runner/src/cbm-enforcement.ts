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
import { looksLikeMissionIntegrationBranch } from '@buildd/core/mission-integration';

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
  /**
   * The ref this task's worktree was actually cut from — `origin/<default>` for a
   * trunk task, the mission integration branch for a mission task that opted in.
   * Resolved, never assumed: it comes from setupWorktree's own answer, so it
   * cannot drift from the branch that really exists.
   *
   * Undefined means "not resolved", which is a real state (a worker with no
   * worktree, or a caller that has not been threaded yet) and is handled by the
   * null-base-ref rule in seedRecordPath rather than guessed at.
   */
  baseRef?: string;
  /**
   * The repo's default base (e.g. `origin/main`). Used ONLY to recognise that
   * `baseRef` is the default one — see seedBaseRefFor.
   */
  defaultBaseRef?: string;
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
  /**
   * Set when a seed for this repo EXISTS but was built from a different base, so
   * it was refused. Both refs are carried because "refused a seed" is only
   * actionable if you can see which base was wanted and which was on offer.
   *
   * This exists as a value rather than only a log line because a silent refusal
   * and a silent stale hit look identical from outside, and this repo has a
   * documented, repeated failure mode of paths that pass while measuring nothing.
   * The caller logs it and it travels into the per-task CBM metrics.
   */
  seedBaseMismatch?: { wanted: string; found: string };
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

/**
 * One logical base ref, one spelling.
 *
 * The runner resolves a base as `origin/<x>` (resolveWorktreeBase), a mission row
 * carries the bare branch name, and git itself will hand back
 * `refs/remotes/origin/<x>`. Those are one base, and keying on the raw string
 * would make two of the three spellings miss a seed that exists — a miss is
 * survivable (it indexes) but it silently throws away the whole point of the
 * shared cache, so collapse them here instead.
 *
 * Returns `undefined` for absent/blank input rather than `''`: "unknown base" is
 * a distinct state with its own rule (see seedRecordPath), and an empty string
 * would key somewhere real.
 */
export function normalizeBaseRef(ref: string | null | undefined): string | undefined {
  if (typeof ref !== 'string') return undefined;
  const trimmed = ref.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  const stripped = trimmed
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '');
  return stripped || undefined;
}

/**
 * Which seed slot a task's base belongs in.
 *
 * The default branch's seed lives in the LEGACY UNKEYED slot, not in a composite
 * one. That is not a special case bolted on — it is the on-disk reality of every
 * already-seeded host, where the one record per repo describes the default branch.
 * Collapsing the default here means:
 *   - a trunk task keeps hitting the seed it hits today, with no migration and no
 *     re-indexing of the whole fleet, and
 *   - a task whose base ref could not be resolved lands in the same slot as a
 *     trunk task, which is the correct degradation because trunk is what an
 *     unresolved base almost always is.
 *
 * A COMPOSITE SLOT IS FOR A MISSION INTEGRATION BRANCH, and the predicate says so
 * rather than saying "not the default". Those two are very different sets, and the
 * difference is not academic: `worktreeBaseRef` is
 * `origin/<context.resumeBranch ?? context.baseBranch>` (resolveWorktreeBase), and
 * four ordinary paths declare a non-trunk base with no A′ flag in sight — a CI
 * retry and any resumed attempt (`ci-retry.ts` sets both fields to the previous
 * worker's `buildd/…` branch), a stacked plan phase (`approve-plan.ts` resolves the
 * predecessor's branch into `context.baseBranch`), and every mission
 * command-criterion verify task.
 *
 * Giving a throwaway `buildd/…` branch its own slot is wrong in both directions:
 *   - READ: it misses the shared trunk seed it used to hit and pays a full
 *     bootstrap index, while the log line reads like a correct safety refusal.
 *   - WRITE: the claim-path refresh then indexes a NEW PERMANENT CBM project for a
 *     branch that is deleted on merge, and the seeder prunes nothing. It also
 *     loosens the concurrency bound — the cooldown admits one seeder per key, so
 *     N declared bases admit N simultaneous full indexes on one host.
 *
 * A mission integration branch has none of those properties: it is shared by the
 * mission's tasks, long-lived, and genuinely divergent from trunk because siblings
 * keep merging into it — which is precisely why the trunk graph is the wrong answer
 * for it and worth a slot of its own.
 *
 * The runner is not told which mission a task belongs to (nothing on the claimed
 * worker payload carries `missionId` or the mission's working branch), so the
 * question is answered by the shared name predicate in
 * `@buildd/core/mission-integration` — the same one the server uses to decide
 * whether a merge is worth announcing as a base advance. Name-based, but it is the
 * one generator of those names (`mission-run.ts`), and being wrong here costs a
 * cache slot, not a correctness gate.
 *
 * Returns undefined for "the unkeyed slot".
 */
export function seedBaseRefFor(input: {
  baseRef?: string | null;
  defaultBaseRef?: string | null;
}): string | undefined {
  const base = normalizeBaseRef(input.baseRef);
  if (base === undefined) return undefined;
  const dflt = normalizeBaseRef(input.defaultBaseRef);
  if (dflt !== undefined && dflt === base) return undefined;
  // Normalized first: the predicate matches the `mission/` prefix, and the raw
  // ref arrives as `origin/mission/…` or `refs/remotes/origin/mission/…`.
  return looksLikeMissionIntegrationBranch(base) ? base : undefined;
}

/**
 * Stable, readable, collision-free seed path for a repo at a base ref.
 *
 * Per base, not per repo: CBM keys a project by the absolute path it was indexed
 * at, so two bases sharing one seed checkout would index as a SINGLE project and
 * overwrite each other — the mission seed clobbering the trunk seed and back
 * again on every refresh, with both recorded as valid.
 *
 * An absent base ref yields the pre-P9 path unchanged, so seeds already on disk
 * stay usable.
 */
export function cbmSeedPathFor(repoPath: string, baseRef?: string | null): string {
  const { createHash } = require('crypto') as typeof import('crypto');
  const { basename } = require('path') as typeof import('path');
  const normalized = repoPath.replace(/\/+$/, '');
  const base = normalizeBaseRef(baseRef);
  const hash = createHash('sha1')
    .update(base === undefined ? normalized : `${normalized}\n${base}`)
    .digest('hex')
    .slice(0, 12);
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
 * Where the seed record for a repo AT A BASE REF lives.
 *
 * Keyed by a hash of `(repoPath, baseRef)` so a record can be found without
 * guessing CBM's slug rules, and so a seed built from one base cannot answer a
 * request for another.
 *
 * THE NULL/UNKNOWN BASE REF RULE, in one place because three call sites depend on
 * it: an absent or unresolvable `baseRef` reads and writes the LEGACY, UNKEYED
 * slot — byte-identical to the pre-P9 path (a hash of the repo path alone). That
 * degrades to exactly today's behaviour: the default-branch seed is found and the
 * bootstrap index is skipped, as it is on every seeded host right now.
 *
 * The rule is deliberately one-directional. A NAMED base ref only ever hits a
 * seed recorded for that same named ref; it never falls back to the legacy slot.
 * That fallback is precisely the false cache hit P9 exists to remove — it is what
 * hands a mission task a trunk graph together with `skipBootstrapIndex: true`, so
 * the task neither has a correct graph nor indexes one for itself.
 */
function seedRecordPath(repoPath: string, baseRef?: string | null): string {
  const { createHash } = require('crypto') as typeof import('crypto');
  const repo = repoPath.replace(/\/+$/, '');
  const base = normalizeBaseRef(baseRef);
  const hash = createHash('sha1')
    .update(base === undefined ? repo : `${repo}\n${base}`)
    .digest('hex')
    .slice(0, 16);
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
export function writeCbmSeedRecord(
  repoPath: string,
  record: CbmSeedRecord,
  opts: {
    /**
     * Also fill the legacy unkeyed slot, so a task whose base ref could not be
     * resolved still finds this seed (today's behaviour).
     *
     * TRUE by default, and that default is chosen to fail safe: the only
     * production writer is scripts/cbm-seed.ts, and if base-ref plumbing were
     * ever mis-wired the worst case is the pre-P9 behaviour rather than every
     * worker on the fleet losing the seed and paying the ~20s index again.
     *
     * A seeder targeting a mission integration branch MUST pass false — writing
     * a mission graph into the slot that unknown-base lookups read is the same
     * stale-graph defect, just pointed the other way.
     */
    alsoDefaultSlot?: boolean;
  } = {},
): void {
  const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs');
  mkdirSync(join(sharedCbmCacheDir(), 'seeds'), { recursive: true });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(seedRecordPath(repoPath, record.ref), body);
  if (opts.alsoDefaultSlot !== false) {
    writeFileSync(seedRecordPath(repoPath, undefined), body);
  }
}

export function readCbmSeedRecord(repoPath: string, baseRef?: string | null): CbmSeedRecord | null {
  const { existsSync, readFileSync } = require('fs') as typeof import('fs');
  const path = seedRecordPath(repoPath, baseRef);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CbmSeedRecord;
    if (!parsed || typeof parsed.project !== 'string') return null;
    // Defence in depth: the record must AGREE with the base ref it was found
    // under. The path hash already encodes the ref, so a disagreement means a
    // hand-edited or hash-colliding file — and serving that is the stale-graph
    // failure again. Only checkable when a ref was named.
    const wanted = normalizeBaseRef(baseRef);
    if (wanted !== undefined && normalizeBaseRef(parsed.ref) !== wanted) return null;
    return parsed;
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
  //
  // Keyed on (repoPath, baseRef). A seed built from trunk is not an answer about a
  // mission integration branch: sibling tasks have been merging into that base, so
  // the trunk graph describes precisely the code that has since changed. Serving it
  // would be bad enough on its own, but a hit also sets skipBootstrapIndex, so the
  // task would get no graph of its own either — a confidently wrong answer instead
  // of a missing one, which is the worse failure. An agent with no index greps; an
  // agent with a stale index believes it.
  let seedBaseMismatch: CbmActivation['seedBaseMismatch'];
  const seedBaseRef = seedBaseRefFor(ctx);
  if (ctx.repoPath) {
    const shared = sharedCbmCacheDir();
    const record = readCbmSeedRecord(ctx.repoPath, seedBaseRef);
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

    // Missed. Distinguish "no seed at all" from "a seed for another base", because
    // only the second says the shared cache is working and merely pointed
    // elsewhere — and only the second is worth a refresh for this base.
    const wanted = seedBaseRef;
    if (wanted !== undefined) {
      const fallbackRecord = readCbmSeedRecord(ctx.repoPath, undefined);
      const found = normalizeBaseRef(fallbackRecord?.ref);
      if (found !== undefined && found !== wanted) {
        seedBaseMismatch = { wanted, found };
      }
    }
  }

  const cbmCacheDir = `/tmp/cbm-${ctx.workerId}`;
  return {
    enforced: true,
    cbmBinaryPath: CBM_BINARY_PATH,
    cbmCacheDir,
    cbmRuntimeDir: cbmRuntimeDirFor(cbmCacheDir),
    ...(seedBaseMismatch ? { seedBaseMismatch } : {}),
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
const seedRefreshAttempts = new Map<string, SeedLease>();

/**
 * Refreshes currently running, keyed the same way as the records themselves.
 *
 * Distinct from the cooldown, which is a rate limit on the CLAIM path. This is a
 * concurrency bound on the base-advance path, where the cooldown must not apply:
 * a merge into the integration branch means the base really moved and the seed
 * really is stale, so suppressing it for ten minutes would leave every sibling
 * claiming against a graph one merge behind.
 *
 * A request that finds the slot taken is DROPPED, not queued. Queueing would be
 * wrong as well as unbounded: the seeder re-reads the ref's current sha when it
 * starts, so the in-flight run already subsumes every advance that happened while
 * it was waiting. A queue would just re-index the same tree N times.
 *
 * A LEASE, not a flag — it stores when the spawn happened and lapses after
 * SEED_RETRY_COOLDOWN_MS. The slot is normally released by the child's `exit`
 * listener, but that signal is not guaranteed: the child is detached, `on` is
 * optional on the injected spawn, and a wedged seeder may never exit at all. A
 * slot released only by a callback is the permanent per-process latch this file
 * already had once (see SEED_RETRY_COOLDOWN_MS) — "no seed, no retry, no log line
 * until someone restarts the runner". Expiry makes it converge either way, which
 * is the direction that fails safe.
 *
 * Because the lease LAPSES, two spawns for one key can legitimately be alive at
 * once, so the record names its HOLDER as well as its time. Release is keyed on
 * `(key, token)`: a wedged seeder that finally exits after its lease lapsed must
 * not delete the successor's lease, or the next request spawns a SECOND
 * concurrent seeder for the same `(repoPath, baseRef)` — two indexers over one
 * seed clone under one fixed CBM_RUNTIME_DIR, which is contention this fleet has
 * already been bitten by.
 */
const seedRefreshInFlight = new Map<string, SeedLease>();

/**
 * A lease record: WHEN it was taken (expiry) and WHO took it (release).
 *
 * The token is a process-local monotonic counter rather than a timestamp — two
 * spawns within one millisecond must still be distinguishable, and an injected
 * clock is free to stand still.
 */
interface SeedLease {
  token: number;
  at: number;
}

let seedLeaseCounter = 0;

/**
 * Drop a lease / cooldown record only while we are still its holder.
 *
 * A no-op when someone else holds it — which is the whole point: our exit says
 * nothing about their run.
 */
function releaseSeedRecord(map: Map<string, SeedLease>, key: string, token: number): void {
  if (map.get(key)?.token === token) map.delete(key);
}

/** The one composite key. Records, cooldown and in-flight slot must never disagree. */
function seedRefreshKey(repoPath: string, baseRef?: string | null): string {
  const base = normalizeBaseRef(baseRef);
  return base === undefined ? repoPath : `${repoPath}\n${base}`;
}

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
  | 'no_base_ref'
  | 'binary_absent'
  | 'script_absent'
  | 'recently_attempted'
  | 'already_in_flight'
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
    /**
     * The base the seed must describe. Omitted = the repo's default branch, which
     * is the pre-P9 behaviour and still what the claim path asks for on a
     * non-mission task.
     */
    baseRef?: string;
    /**
     * Skip the claim-path cooldown. For an event that means "the base moved"
     * (a task PR merged into the integration branch), where the cooldown would
     * be suppressing exactly the refresh that is now required. Still bounded by
     * the in-flight slot.
     */
    ignoreCooldown?: boolean;
  } = {},
): SeedRefreshOutcome {
  const pathExists = deps.pathExists ?? ((p: string) => {
    const { existsSync } = require('fs') as typeof import('fs');
    return existsSync(p);
  });
  const now = deps.now ?? (() => Date.now());

  if (!repoPath) return 'no_repo_path';
  if (!pathExists(CBM_BINARY_PATH)) return 'binary_absent';

  const key = seedRefreshKey(repoPath, deps.baseRef);

  if (!deps.ignoreCooldown) {
    const lastAttempt = seedRefreshAttempts.get(key);
    if (lastAttempt !== undefined && now() - lastAttempt.at < SEED_RETRY_COOLDOWN_MS) {
      return 'recently_attempted';
    }
  }

  // Bound: at most one refresh in flight per (repoPath, baseRef). Dropped, not
  // queued — see seedRefreshInFlight. The lease shares SEED_RETRY_COOLDOWN_MS
  // deliberately: "an attempt older than the cooldown no longer counts" is one
  // rule, whether or not we ever saw the child exit.
  const inFlightSince = seedRefreshInFlight.get(key);
  if (inFlightSince !== undefined && now() - inFlightSince.at < SEED_RETRY_COOLDOWN_MS) {
    return 'already_in_flight';
  }

  const script = deps.scriptPath ?? join(import.meta.dir, '..', 'scripts', 'cbm-seed.ts');
  if (!pathExists(script)) return 'script_absent';

  const baseRefArgs = deps.baseRef ? ['--base-ref', deps.baseRef] : [];
  // One token for this attempt, stamped on both records, so every later release
  // can ask "is this still mine?" instead of assuming it is.
  const token = ++seedLeaseCounter;
  seedRefreshAttempts.set(key, { token, at: now() });
  seedRefreshInFlight.set(key, { token, at: now() });
  try {
    const spawn = deps.spawnProcess ?? (require('child_process') as typeof import('child_process')).spawn;
    const logFd = (deps.openLogFd ?? openSeedLogFd)();
    // The base ref goes through VERBATIM, not normalized: the seeder resolves it
    // with git, which needs the spelling that actually exists as a ref. Only the
    // in-process key is normalized.
    const child = spawn(deps.runtime ?? process.execPath, [script, repoPath, ...baseRefArgs], {
      detached: true,
      // stdin closed, stdout+stderr to the seed log. Was 'ignore', which threw
      // away the only description of why a seed did not happen.
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
    });
    // The refresh is still fire-and-forget — nothing awaits this — but a failed
    // seeder must not hold the cooldown, or one early failure suppresses every
    // later attempt for the life of the process.
    child.on?.('exit', (code: number | null) => {
      // Release OUR slot. A leaked slot is the permanent-latch bug the cooldown
      // replaced, and on an advancing base it would freeze the seed at the first
      // advance for the life of the runner process — but releasing someone
      // else's is the mirror-image bug: a wedged child exiting long after its
      // lease lapsed would hand the key to a second concurrent seeder.
      releaseSeedRecord(seedRefreshInFlight, key, token);
      if (code !== 0) {
        // Same rule for the cooldown: clearing it must not clear a newer
        // caller's, or one wedged child re-opens the burst window.
        releaseSeedRecord(seedRefreshAttempts, key, token);
        console.warn(`[cbm-seed] seeder for ${key.replace('\n', ' @ ')} exited ${code} — see ${cbmSeedLogPath()}`);
      }
    });
    child.unref?.();
    return 'spawned';
  } catch {
    // A failed refresh must never affect the worker — it just means no seed yet.
    // Holder-checked like every other release, even though nothing can have
    // taken the key since the two `set`s above: one rule, no exceptions to audit.
    releaseSeedRecord(seedRefreshAttempts, key, token);
    releaseSeedRecord(seedRefreshInFlight, key, token);
    return 'spawn_failed';
  }
}

/**
 * The integration branch advanced — refresh that base's seed now.
 *
 * Entry point for "a task PR merged into the mission integration branch". The base
 * has moved, so the seed for THAT base (and only that base) is stale. Distinct
 * from the claim-path refresh in two ways: it names the base ref explicitly, and
 * it is not subject to the claim-path cooldown, because the cooldown exists to
 * absorb bursts of claims and this is a real state change.
 *
 * Still bounded — one in flight per `(repoPath, baseRef)`, second request dropped.
 * The seeder itself does the incremental work (detect_changes over a full
 * re-index) and exits immediately when the ref has not actually moved, so calling
 * this speculatively is cheap and calling it on every merge is correct.
 *
 * Fire-and-forget by construction: it returns an outcome to LOG, never a promise
 * to await. Nothing on a worker's critical path may block on indexing.
 */
export function refreshCbmSeedForBaseAdvance(
  input: { repoPath: string; baseRef: string },
  deps: Parameters<typeof spawnCbmSeedRefresh>[1] = {},
): SeedRefreshOutcome {
  // An advance with no resolvable base is not actionable: refreshing "the default
  // slot" instead would rebuild the trunk seed in response to a mission merge,
  // which is both useless and misleading in the log.
  if (normalizeBaseRef(input.baseRef) === undefined) return 'no_base_ref';
  return spawnCbmSeedRefresh(input.repoPath, {
    ...deps,
    baseRef: input.baseRef,
    ignoreCooldown: true,
  });
}

/** Test seam: forget which repos have already been asked to refresh. */
export function resetCbmSeedRefreshState(): void {
  seedRefreshAttempts.clear();
  seedRefreshInFlight.clear();
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
