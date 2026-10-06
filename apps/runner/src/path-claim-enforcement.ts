/**
 * Path-claim enforcement: the runner half of knowledge-base: buildd/design/conflict-aware-orchestration.md
 * §2 ("Automatic declaration and checkpoint sweeps").
 *
 * Two mechanisms, deliberately named differently because they promise different
 * things:
 *
 *  - **Pre-edit** (Claude Edit/Write/MultiEdit only). The PreToolUse hook in
 *    hook-factory.ts acquires the target path before the write lands. In
 *    `enforce` mode a confirmed live holder denies the edit and names the
 *    blocking task and path. That is a real guarantee, but only for those three
 *    tools.
 *  - **Checkpoint** (everything else: Bash writes, untracked files, Codex). A
 *    sweep at sync, pre-push and completion unions the committed diff against
 *    the task's resolved PR base with staged/unstaged/untracked status, and
 *    offers it to the server's exclusive acquisition. A collision found there
 *    has already happened. Nothing here can honestly claim it was prevented, so
 *    the response is to stop further writes/push/completion, persist a
 *    checkpoint and defer the task — never to keep the agent alive waiting.
 *
 * Off by default: `gitConfig.pathClaimEnforcement` must be `'enforce'`.
 * Everything here is pure or takes the worktree path explicitly, so it can be
 * tested against real throwaway repos.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import { branchOfRemoteRef, remoteBranchFetchArgs } from './git-clone';
import {
  resolveTaskPrBase,
  missionIntegrationBase,
  isMissionPrTask,
  type MissionIntegrationFields,
  type TaskPrBaseTask,
} from '@buildd/core/mission-integration';

export type PathClaimMode = 'advisory' | 'enforce';

/** Workspace opt-in. Anything but the exact string `'enforce'` is advisory. */
export function resolvePathClaimMode(gitConfig: { pathClaimEnforcement?: unknown } | null | undefined): PathClaimMode {
  return gitConfig?.pathClaimEnforcement === 'enforce' ? 'enforce' : 'advisory';
}

/** What each backend can actually promise. Advertised at session start. */
export interface BackendEnforcement {
  /** A write can be refused before it lands (PreToolUse on Edit/Write/MultiEdit). */
  preEdit: boolean;
  /** Writes are found after the fact by the sync/pre-push/completion sweep. */
  checkpoint: true;
}

export function backendEnforcement(backend: string | undefined): BackendEnforcement {
  // Codex has no PreToolUse seam (see workers.ts hook wiring).
  return { preEdit: backend !== 'codex', checkpoint: true };
}

export function describeEnforcement(backend: string | undefined, mode: PathClaimMode): string {
  if (mode !== 'enforce') return 'Path claims: advisory (conflicts are reported, never enforced)';
  return backendEnforcement(backend).preEdit
    ? 'Path claims: enforcing. Edit/Write/MultiEdit acquire before writing; Bash and untracked writes are checked at checkpoints (sync, push, completion)'
    : 'Path claims: enforcing at checkpoints only (sync). This backend has no pre-write seam, so a write is found after it happened, not refused before it';
}

// ── Path normalization ───────────────────────────────────────────────────────

export type NormalizedPath =
  | { ok: true; path: string }
  | { ok: false; reason: 'empty' | 'root' | 'escape'; raw: string };

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function realpathOrSelf(p: string): string {
  try {
    return typeof fs.realpathSync === 'function' ? fs.realpathSync(p) : p;
  } catch {
    return p;
  }
}

/**
 * A tool path, made relative to the task worktree. Absolute paths inside the
 * worktree are accepted (both the literal root and its realpath, so a
 * `/tmp` → `/private/tmp` symlink does not read as an escape); anything that
 * resolves outside it — `..`, another worktree, `~` — is an escape and is never
 * sent to the server as a claim.
 */
export function normalizeWorktreePath(raw: string, worktreeRoot: string): NormalizedPath {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { ok: false, reason: 'empty', raw: String(raw) };
  if (trimmed.startsWith('~')) return { ok: false, reason: 'escape', raw: trimmed };

  const realRoot = realpathOrSelf(resolve(worktreeRoot));
  const roots = [...new Set([resolve(worktreeRoot), realRoot])];
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(roots[0], trimmed);
  for (const root of roots) {
    const rel = relative(root, abs);
    if (rel === '') return { ok: false, reason: 'root', raw: trimmed };
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      // Lexically inside. A symlink inside the worktree can still point out of
      // it, so the nearest existing ancestor's realpath must stay inside too.
      const real = realpathOfNearestExisting(abs, root);
      if (real && !within(realRoot, real)) return { ok: false, reason: 'escape', raw: trimmed };
      return { ok: true, path: toPosix(rel) };
    }
  }
  return { ok: false, reason: 'escape', raw: trimmed };
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * realpath of `p`, or of its closest existing ancestor strictly below `root`
 * (a new file's directory). Null when nothing below the root exists yet: the
 * root itself is already accounted for.
 */
function realpathOfNearestExisting(p: string, root: string): string | null {
  let cur = p;
  while (cur !== root && within(root, cur)) {
    try {
      if (fs.existsSync(cur)) return realpathOrSelf(cur);
    } catch { /* try the parent */ }
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * File paths an Edit/Write/MultiEdit call writes. MultiEdit carries one
 * top-level `file_path`; per-edit `file_path` entries are accepted too.
 */
export function extractEditPaths(toolName: string, toolInput: Record<string, unknown> | undefined): string[] {
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') return [];
  const out: string[] = [];
  const add = (p: unknown) => {
    if (typeof p === 'string' && p.trim() && !out.includes(p)) out.push(p);
  };
  add(toolInput?.file_path);
  if (toolName === 'MultiEdit' && Array.isArray(toolInput?.edits)) {
    for (const edit of toolInput!.edits as Array<Record<string, unknown>>) add(edit?.file_path);
  }
  return out;
}

// ── Runtime exclusions ───────────────────────────────────────────────────────

/**
 * Runtime and scratch artifacts a sweep never offers as edits, even when a
 * repo forgot to ignore them. Explicit and short on purpose: an exclusion is a
 * file nobody will ever be told they collided on. Gitignored files never reach
 * the sweep at all (status does not list them), so this only matters for
 * untracked noise the runner itself creates.
 */
export const RUNTIME_EXCLUSIONS: readonly string[] = [
  '.buildd/',
  '.buildd-worktrees/',
  'node_modules/',
  '.test-report.log',
];

export function isRuntimeExcluded(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return RUNTIME_EXCLUSIONS.some(rule =>
    rule.endsWith('/')
      ? p === rule.slice(0, -1) || p.startsWith(rule) || p.includes(`/${rule}`)
      : p === rule || p.endsWith(`/${rule}`),
  );
}

// ── NUL-delimited git output ─────────────────────────────────────────────────

/**
 * `git status --porcelain=v1 -z --untracked-files=all`. Entries are
 * `XY path\0`; a rename or copy is followed by its source as its own field.
 * Both sides are returned: the source is an edit (it disappears) as much as the
 * destination.
 */
export function parsePorcelainZ(output: string): string[] {
  const fields = output.split('\0');
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    out.push(entry.slice(3));
    if (xy.includes('R') || xy.includes('C')) {
      const source = fields[i + 1];
      if (source) out.push(source);
      i++;
    }
  }
  return out;
}

/** `git diff --name-status -z -M`. `R100\0old\0new\0`, `M\0path\0`, `D\0path\0`. */
export function parseNameStatusZ(output: string): string[] {
  const fields = output.split('\0');
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      if (fields[i + 1]) out.push(fields[i + 1]);
      if (fields[i + 2]) out.push(fields[i + 2]);
      i += 2;
    } else {
      if (fields[i + 1]) out.push(fields[i + 1]);
      i += 1;
    }
  }
  return out;
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export interface WorktreeSweep {
  /** Union of committed and uncommitted changes, runtime exclusions removed, sorted. */
  paths: string[];
  committed: string[];
  uncommitted: string[];
  /** The ref the committed half was measured against, as given. */
  baseRef: string | null;
  /**
   * False when no base was given or its merge-base could not be computed. The
   * committed half is then empty — never re-measured against a guessed trunk,
   * which on a mission branch would lease the integration branch's history.
   */
  baseResolved: boolean;
  /** Set when git itself failed; the sweep is then incomplete, not empty. */
  error?: string;
}

const GIT_TIMEOUT_MS = 5000;

// This sweep runs every sync tick against the WORKER'S OWN LIVE worktree,
// concurrently with whatever the agent itself is doing there (staging,
// committing). `status`/`diff` opportunistically refresh and rewrite the
// on-disk index to cache fresh stat info, which takes index.lock — racing an
// agent `git add`/`git commit` in the same worktree. GIT_OPTIONAL_LOCKS=0
// makes git skip that write-back; the read output this sweep actually uses
// is identical either way.
function git(cwd: string, args: string, timeout = GIT_TIMEOUT_MS): string {
  return childProcess.execSync(`git ${args}`, {
    cwd,
    timeout,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }) as unknown as string;
}

/** Shell-safe single-quoted argument (refs are user-ish data: branch names). */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Every path this task has changed relative to its resolved PR base: committed
 * changes since `merge-base(HEAD, baseRef)` — renames as both source and
 * destination, deletes, new files — plus staged, unstaged and untracked files.
 * This is what catches Bash and Codex writes, which never pass through a
 * pre-edit hook.
 */
export function sweepWorktreeChanges(worktreePath: string, baseRef: string | null | undefined): WorktreeSweep {
  const result: WorktreeSweep = { paths: [], committed: [], uncommitted: [], baseRef: baseRef ?? null, baseResolved: false };
  const errors: string[] = [];

  if (baseRef) {
    try {
      const mergeBase = String(git(worktreePath, `merge-base HEAD ${shellQuote(baseRef)}`)).trim();
      if (mergeBase) {
        result.baseResolved = true;
        result.committed = parseNameStatusZ(String(git(worktreePath, `diff --name-status -z -M ${mergeBase} HEAD`)));
      }
    } catch (err) {
      // An unresolvable base is reported, not papered over with a trunk guess.
      result.baseResolved = false;
    }
  }

  try {
    result.uncommitted = parsePorcelainZ(String(git(worktreePath, 'status --porcelain=v1 -z --untracked-files=all')));
  } catch (err) {
    errors.push(`status: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }

  const union = new Set<string>();
  for (const p of [...result.committed, ...result.uncommitted]) {
    if (p && !isRuntimeExcluded(p)) union.add(p);
  }
  result.paths = [...union].sort();
  if (errors.length > 0) result.error = errors.join('; ');
  return result;
}

/**
 * The ref a task's PR is compared against, which is what a checkpoint sweep
 * must measure the committed half against. It is not the ref the worktree was
 * cut from: on a resume that is the prior attempt's branch, and
 * `merge-base(HEAD, resume branch)` drops every file earlier attempts
 * committed. Their leases were released when they went terminal, so the sweep
 * would push them without ever re-acquiring them.
 *
 * Derived from `resolveTaskPrBase`, the same rule the prompt and `create_pr`
 * use, so the three cannot disagree. In particular a `context.baseBranch` that
 * equals the task's own head (or its `resumeBranch`) is the continuity marker
 * CI retries, conflict retries, answer resumes and infra requeues all write,
 * never a base; a mission task takes its integration branch from the mission.
 *
 * Returns undefined, never trunk, when this is a mission task whose base cannot
 * be named (mission fields missing from the claim, or the integration branch
 * missing on the remote): measuring a mission task against trunk would lease
 * the integration branch's whole history. With no base the sweep reports only
 * uncommitted changes.
 */
export function resolvePrBaseRef(opts: {
  task: (TaskPrBaseTask & {
    missionId?: string | null;
    mission?: MissionIntegrationFields | null;
    context?: Record<string, unknown> | null;
  }) | null | undefined;
  /** The worker's own branch after setup (the resume branch on a resume). */
  head: string | null | undefined;
  /** The ref the worktree was actually cut from (setupWorktree's `base`). */
  worktreeBase: string | null | undefined;
  /** Trunk-ward fallbacks, most specific first (targetBranch, defaultBranch). */
  fallbacks: Array<string | null | undefined>;
  /** setupWorktree's fallback: a candidate base that was missing/diverged. */
  worktreeFallback?: { candidate: string; reason: 'missing' | 'diverged' } | null;
}): string | undefined {
  const task = opts.task ?? {};
  const ctx = (task.context ?? {}) as Record<string, unknown>;
  const resume = typeof ctx.resumeBranch === 'string' && ctx.resumeBranch ? ctx.resumeBranch : undefined;
  // resolveTaskPrBase already ignores baseBranch == head; a baseBranch naming
  // the resume branch is the same marker even if the head was diverted.
  const context = resume && ctx.baseBranch === resume
    ? Object.fromEntries(Object.entries(ctx).filter(([k]) => k !== 'baseBranch'))
    : ctx;
  const mission = task.mission ?? null;
  const missingIntegration = !!opts.worktreeFallback && opts.worktreeFallback.reason === 'missing'
    && opts.worktreeFallback.candidate === missionIntegrationBase(mission);

  const r = resolveTaskPrBase({
    mission,
    task: { title: task.title, taskClass: task.taskClass, context },
    head: opts.head ?? null,
    integrationBaseMissing: missingIntegration,
  });
  const isMissionPrOwner = isMissionPrTask({ title: task.title, taskClass: task.taskClass });
  // A mission task whose integration branch cannot be named.
  const missionBaseUnknown = !isMissionPrOwner && !!task.missionId && (
    mission == null
    || (!!mission.integrationBranchEnabled && !missionIntegrationBase(mission))
    || missingIntegration
  );

  if (r.base) {
    // A stacked predecessor that is gone: the worktree (and the PR) fell back to trunk.
    const fb = opts.worktreeFallback;
    if (fb && fb.reason === 'missing' && fb.candidate === r.base && r.source !== 'mission_integration') {
      return opts.worktreeBase || undefined;
    }
    return `origin/${r.base}`;
  }
  if (missionBaseUnknown) return undefined;
  for (const f of opts.fallbacks) {
    const v = f?.trim();
    if (v) return `origin/${v}`;
  }
  return undefined;
}

/**
 * Bring `origin/<branch>` up to date so the merge-base is the base the PR will
 * actually be compared against. Bounded, asynchronous (a fetch must never block
 * the runner's event loop), and never called from the hot PreToolUse path.
 * Returns whether the fetch succeeded.
 */
export function refreshBaseRef(worktreePath: string, baseRef: string | null | undefined, timeoutMs = 15_000): Promise<boolean> {
  if (!baseRef || !baseRef.startsWith('origin/')) return Promise.resolve(false);
  const branch = branchOfRemoteRef(baseRef);
  if (!branch) return Promise.resolve(false);
  if (typeof childProcess.execFile !== 'function') return Promise.resolve(false);
  return new Promise(resolvePromise => {
    try {
      childProcess.execFile(
        'git',
        // A depth when a shallow (cloud) clone does not have the branch yet:
        // an undeepened fetch of a new ref there downloads its whole history.
        remoteBranchFetchArgs(worktreePath, branch),
        { cwd: worktreePath, timeout: timeoutMs },
        (err) => resolvePromise(!err),
      );
    } catch {
      resolvePromise(false);
    }
  });
}

// ── Collisions ───────────────────────────────────────────────────────────────

export type CollisionSource = 'hook_flush' | 'sync' | 'pre_push' | 'completion';

export interface PathCollision {
  /** The path this task changed. */
  path: string;
  blockingTaskId: string;
  blockingTaskTitle?: string | null;
  /** The holder's lease that overlaps it (may be a directory). */
  blockingPath?: string | null;
  source: CollisionSource;
  detectedAt: number;
}

export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

export function describeHolder(c: { blockingTaskId: string; blockingTaskTitle?: string | null; blockingPath?: string | null }): string {
  const title = c.blockingTaskTitle ? `"${c.blockingTaskTitle}" ` : '';
  const held = c.blockingPath ? ` (it holds ${c.blockingPath})` : '';
  return `task ${title}(${shortTaskId(c.blockingTaskId)})${held}`;
}

/** The `Deferred:` error the server requeues on without charging a retry. */
export function collisionDeferralError(c: PathCollision): string {
  return `Deferred: path collision — ${c.path} is held by ${describeHolder(c)}; this task waits for it to release`;
}

/** Normalize a server-reported collision list entry. */
export function toCollision(raw: unknown, source: CollisionSource, now = Date.now()): PathCollision | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== 'string' || typeof r.blockingTaskId !== 'string') return null;
  return {
    path: r.path,
    blockingTaskId: r.blockingTaskId,
    blockingTaskTitle: typeof r.blockingTaskTitle === 'string' ? r.blockingTaskTitle : null,
    blockingPath: typeof r.blockingPath === 'string' ? r.blockingPath : null,
    source,
    detectedAt: now,
  };
}

/** `git push` / `gh pr create` — the Bash calls that ship a branch. */
export function isShipCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return /(^|[\s;&|(])git(\s+-C\s+\S+)?(\s+-c\s+\S+)*\s+push(\s|$)/.test(command)
    || /(^|[\s;&|(])gh\s+pr\s+create(\s|$)/.test(command);
}

/**
 * The one coordination deadline for a path claim, and the edit's worst-case
 * wait on it. Calibrated from production: round trips to the claim route run
 * ~75-425ms (even a cheap 401), so the old 200ms abort fired on healthy
 * requests — real grants were reported "unavailable" and, in enforce mode, a
 * real 409 arriving late failed open. 1.5s is ~3.5x the observed worst case;
 * past it the service is treated as genuinely unavailable and the edit fails
 * open with its paths queued.
 */
export const PATH_CLAIM_TIMEOUT_MS = 1_500;

/**
 * Hook backstop, strictly above PATH_CLAIM_TIMEOUT_MS so it only fires for a
 * client that ignores its abort signal — never ahead of a request that is
 * still inside its own deadline.
 */
export const PATH_CLAIM_HOOK_DEADLINE_MS = PATH_CLAIM_TIMEOUT_MS + 250;

/** Cap on queued paths; a coordination service down for a long session must not grow memory without bound. */
export const MAX_PENDING_PATHS = 500;
