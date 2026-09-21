/**
 * Worktree utility functions for the runner.
 *
 * Extracted from workers.ts for testability.
 */

export type BranchFetchResult = 'ok' | 'missing' | 'diverged';

export interface ResolveWorktreeBaseOptions {
  defaultBranch: string;
  context: Record<string, unknown> | undefined | null;
  /** Async probe: fetch the named branch from origin and return its status. */
  fetchBranch?: (branch: string) => Promise<BranchFetchResult>;
  /** If provided, log messages about fallbacks. */
  log?: (msg: string) => void;
  /**
   * Called when a resume candidate was requested but could not be used
   * (missing/diverged on remote) and we fell back to `defaultBranch`. Lets the
   * caller clear stale resume state so downstream prompt-building doesn't
   * reference a branch that no longer exists.
   */
  onFallback?: (info: { candidate: string; reason: 'missing' | 'diverged' }) => void;
}

/**
 * Resolve the git base ref for a new worktree.
 *
 * Prefers `context.resumeBranch` (new canonical field) over `context.baseBranch`
 * (legacy CI retry field). If a `fetchBranch` probe is supplied, it verifies the
 * remote branch before returning it. Without a probe the candidate is returned
 * optimistically (backward compat for callers that haven't wired up the probe).
 *
 * WHY THE TWO FIELDS ARE NOT INTERCHANGEABLE HERE. They feed the same ladder,
 * but a `'diverged'` probe result means opposite things for each:
 *
 *  - `resumeBranch` is a *prior attempt*. More than 50 commits ahead of trunk
 *    means that attempt ran away; starting fresh is the safe move.
 *  - `baseBranch` is a base the task was *deliberately told to build on* — a
 *    stacked predecessor, or a mission integration branch under Option A′.
 *    Being ahead of trunk is the whole purpose of such a branch, and falling
 *    back to trunk is actively destructive: the worktree gets cut from trunk
 *    while the task context still names the integration branch, so the PR opens
 *    against a base its commits were never derived from and the diff reads as
 *    though it reverts every sibling change already landed there.
 *
 * So divergence only vetoes a resume candidate. `'missing'` still vetoes both —
 * git cannot cut a worktree from a ref that does not exist.
 *
 * A missing `resumeBranch` does NOT veto a still-valid `declaredBase`, though.
 * The specific branch a prior attempt pushed to being gone says nothing about
 * whether the task's own declared base (a stacked predecessor, or a mission
 * integration branch under Option A′) is still there — and for a
 * mission-branch task, falling straight to trunk from here reproduces the bug
 * the declared_base path above already guards against: the worktree is cut
 * from trunk while task context still names the real base, so the PR opens
 * against a base its commits were never derived from. Worse, that task's own
 * `branch` (its `workers.branch`, set via `sharedHeadBranch` precedence — see
 * branch-names.ts) is often the literal mission integration branch name, so
 * the fresh worktree branch collides with the one head `create_pr` refuses to
 * accept for a task PR. So on a missing resumeBranch, cascade to the declared
 * base (validated the same way the declared_base path validates it) before
 * giving up on trunk. A *diverged* resumeBranch skips this cascade and still
 * falls straight to trunk — a resume branch 50+ commits ahead of trunk is a
 * red flag about that attempt specifically, independent of whatever base the
 * task declared.
 *
 * @returns A git ref like `origin/main` or `origin/buildd/abc-fix-tests`
 */
export async function resolveWorktreeBase(
  opts: ResolveWorktreeBaseOptions,
): Promise<string> {
  const { defaultBranch, context, fetchBranch, log, onFallback } = opts;

  const resumeCandidate =
    typeof context?.resumeBranch === 'string' && context.resumeBranch.length > 0
      ? (context.resumeBranch as string)
      : undefined;
  const declaredBase =
    typeof context?.baseBranch === 'string' && (context.baseBranch as string).length > 0
      ? (context.baseBranch as string)
      : undefined;

  // The declared_base ladder rung: used both when there's no resume candidate
  // at all, and as the resume path's fallback once resumeBranch turns out to
  // be missing.
  const resolveDeclaredBaseOrDefault = async (): Promise<string> => {
    if (!declaredBase) return `origin/${defaultBranch}`;
    if (!fetchBranch) return `origin/${declaredBase}`;
    const result = await fetchBranch(declaredBase);
    if (result === 'missing') {
      log?.(`[worktree] baseBranch ${declaredBase} not found on remote — falling back to ${defaultBranch}`);
      onFallback?.({ candidate: declaredBase, reason: 'missing' });
      return `origin/${defaultBranch}`;
    }
    // 'diverged' is expected, not a fault: a declared base is supposed to be
    // ahead of trunk. Divergence only vetoes a resume branch.
    return `origin/${declaredBase}`;
  };

  if (!resumeCandidate) {
    return resolveDeclaredBaseOrDefault();
  }

  if (!fetchBranch) {
    // No probe available — return optimistically (backward compat)
    return `origin/${resumeCandidate}`;
  }

  const result = await fetchBranch(resumeCandidate);
  if (result === 'ok') {
    return `origin/${resumeCandidate}`;
  }
  if (result === 'diverged') {
    log?.(`[worktree] resumeBranch ${resumeCandidate} is diverged beyond recovery — falling back to ${defaultBranch}`);
    onFallback?.({ candidate: resumeCandidate, reason: 'diverged' });
    return `origin/${defaultBranch}`;
  }

  // result === 'missing'
  log?.(
    `[worktree] resumeBranch ${resumeCandidate} not found on remote — falling back to ` +
    (declaredBase ? `declared base ${declaredBase}` : defaultBranch),
  );
  onFallback?.({ candidate: resumeCandidate, reason: 'missing' });
  return resolveDeclaredBaseOrDefault();
}

/**
 * Retry-continuity fields carried on a task context when a prior attempt left
 * commits on a resume branch. When the runner cannot use that branch (it is gone
 * from the remote or diverged) it starts fresh — these fields must be cleared so
 * prompt-building never references a branch that no longer exists.
 */
export const RESUME_CONTEXT_FIELDS = ['resumeBranch', 'lastCommitSha', 'failureContext'] as const;

/**
 * Strip retry-continuity fields from a task context in place. Called on fallback
 * to a fresh base so {@link buildRetryContinuitySection} yields no resume
 * instructions and the worker starts clean.
 */
export function clearResumeContext(
  context: Record<string, unknown> | undefined | null,
): void {
  if (!context) return;
  for (const field of RESUME_CONTEXT_FIELDS) {
    delete context[field];
  }
}

export interface RetryContinuityOptions {
  /** The prior attempt's branch, from `context.resumeBranch`. */
  resumeBranch?: unknown;
  /** The prior attempt's tip commit, from `context.lastCommitSha`. */
  lastCommitSha?: unknown;
  /** The prior attempt's failure context (string or `{ summary }`). */
  failureContext?: unknown;
  /** The workspace default branch (e.g. `dev`/`main`) — required, always in scope. */
  defaultBranch: string;
}

/**
 * Build the "Prior Attempt — Assess Before Starting" prompt section for a
 * resumed task.
 *
 * Returns `null` when there is no usable resume branch (fresh start) so callers
 * can simply skip appending — this is what a fallback-to-default run produces
 * once {@link clearResumeContext} has stripped the stale `resumeBranch`.
 *
 * All inputs are explicit — importantly `defaultBranch` — so the returned text
 * never references an out-of-scope variable (the historical crash: `defaultBranch`
 * was undefined in the session-building scope, throwing a ReferenceError on every
 * resume).
 */
export function buildRetryContinuitySection(
  opts: RetryContinuityOptions,
): string | null {
  const resumeBranch =
    typeof opts.resumeBranch === 'string' && opts.resumeBranch.length > 0
      ? opts.resumeBranch
      : undefined;
  if (!resumeBranch) return null;

  const lastCommitSha =
    typeof opts.lastCommitSha === 'string' && opts.lastCommitSha.length > 0
      ? opts.lastCommitSha
      : undefined;
  const rawFailureCtx = opts.failureContext;
  const failureSummary: string | undefined =
    typeof rawFailureCtx === 'string'
      ? rawFailureCtx
      : (rawFailureCtx as { summary?: string } | undefined | null)?.summary;

  const sha = lastCommitSha ?? `origin/${resumeBranch}`;
  const failureLine = failureSummary ? [`3. The prior attempt failed with: ${failureSummary}`] : [];
  const decideStep = failureSummary ? '4' : '3';
  const logStep = failureSummary ? '5' : '4';
  return [
    '',
    '## Prior Attempt — Assess Before Starting',
    '',
    'A previous agent attempt left commits on this branch. Before editing any file:',
    '',
    `1. Run \`git log --oneline origin/${resumeBranch}..HEAD\` to see what this attempt has already done.`,
    `   (If the worktree is already on \`${resumeBranch}\`, run \`git log --oneline ${sha}~1..HEAD\` instead.)`,
    `2. Run \`git diff origin/${opts.defaultBranch}...origin/${resumeBranch}\` to see what the prior attempt changed relative to base.`,
    ...failureLine,
    `${decideStep}. Explicitly decide: **continue/salvage** (fix what failed, keep prior commits) or **restart** (reset to base, start clean).`,
    `${logStep}. Log your decision via \`update_progress\` **before** making any file edits.`,
    '',
    'Do not skip this assessment step. The decision and its rationale must appear in the progress log.',
  ].join('\n');
}

/**
 * Abandoned `waiting` workers keep their worktree for possible session resume,
 * but waiting-input tasks are almost never resumed in practice. Reclaim the
 * worktree after this TTL so it cannot leak indefinitely. Matches the 24h
 * worker-store load TTL (records older than this are dropped on restart, which
 * is exactly when a leftover worktree would otherwise become an unowned orphan).
 */
export const WAITING_WORKTREE_TTL_MS = 24 * 60 * 60 * 1000;

/** Idle threshold before a leftover worktree is considered stale/removable. */
export const STALE_WORKTREE_IDLE_MS = 60 * 60 * 1000;

/** The minimal in-memory worker shape the ownership check needs. */
export interface WorktreeOwnershipRecord {
  worktreePath?: string;
  status?: string;
}

/**
 * Is `worktreePath` currently owned by a LIVE worker other than
 * `excludeWorkerId`?
 *
 * Worktree paths used to be keyed on the REQUESTED branch (see setupWorktree),
 * so a mission's tasks — all handed the same shared head branch by
 * `generateTaskBranchName` — computed one directory while holding N distinct
 * branches. A retry on the same task computes the identical path too. Any
 * removal must therefore consult this first: `git worktree remove --force`
 * exits 0 *after* deleting another worker's work, so there is no second line of
 * defence, and a clean `git status` does not mean idle — an agent that has
 * committed (common: commit early, push late) reads clean while its SDK session
 * still has that path as `cwd`.
 *
 * "Live" is anything short of the two terminal statuses: `stale` and `waiting`
 * workers can still resume into the same session and the same worktree.
 *
 * Matching is exact, deliberately. Prefix matching would also protect every
 * `-w<id8>` diversion hanging off the same stem, which is the population the
 * reaper exists to reclaim.
 */
export function isWorktreePathOwnedByOtherLiveWorker(
  workers: Iterable<[string, WorktreeOwnershipRecord]>,
  worktreePath: string,
  excludeWorkerId: string,
): boolean {
  for (const [id, other] of workers) {
    if (id === excludeWorkerId) continue;
    if (other.worktreePath === worktreePath && other.status !== 'done' && other.status !== 'error') {
      return true;
    }
  }
  return false;
}

/**
 * Does this branch name identify a per-task buildd worktree branch?
 * Matches the `buildd/<slug>` task branches and the `--e2e-test-` ephemeral
 * pattern. Branches outside this set (e.g. `main`, human feature branches) are
 * never touched by the sweep.
 */
export function isBuilddTaskBranch(branch: string | null | undefined): boolean {
  if (!branch) return false;
  return branch.startsWith('buildd/') || branch.includes('--e2e-test-');
}

/**
 * Parse `git worktree list --porcelain` output into {path, branch} entries.
 * `branch` is the short branch name (refs/heads/ stripped) or null when the
 * worktree is detached/bare. The first entry is always the main worktree.
 */
export function parseWorktreeList(porcelain: string): { path: string; branch: string | null }[] {
  const out: { path: string; branch: string | null }[] = [];
  let cur: { path: string; branch: string | null } | null = null;
  for (const raw of porcelain.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length), branch: null };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Liveness/terminality of the worker (if any) that owns a leftover worktree.
 * - `live`    — a worker is actively using it (working/stale, or waiting within TTL)
 * - `terminal`— the owning worker finished (done/error) or is a waiting worker past TTL
 * - `orphan`  — no worker record owns it (e.g. record aged out of the 24h store TTL)
 */
export type WorktreeOwnerState = 'live' | 'terminal' | 'orphan';

/**
 * Decide whether a leftover worktree may be removed by the sweep. Pure so the
 * safety gates can be unit-tested without git/fs.
 *
 * Gates (all must pass to remove):
 *  1. Idle at least `idleThresholdMs` — never touch a fresh/in-use worktree.
 *  2. Not owned by a live worker — active work is protected.
 *  3. Either a true orphan (unrecoverable, safe to reclaim) OR a terminal task
 *     whose branch is already pushed (removing it cannot lose unpushed commits).
 */
export function shouldRemoveWorktree(opts: {
  idleMs: number;
  idleThresholdMs: number;
  owner: WorktreeOwnerState;
  branchPushed: boolean;
}): { remove: boolean; reason: string } {
  if (opts.idleMs < opts.idleThresholdMs) {
    return { remove: false, reason: 'not idle long enough' };
  }
  if (opts.owner === 'live') {
    return { remove: false, reason: 'owned by live worker' };
  }
  if (opts.owner === 'orphan') {
    return { remove: true, reason: 'orphaned (no worker record)' };
  }
  // terminal
  if (opts.branchPushed) {
    return { remove: true, reason: 'terminal task, branch pushed' };
  }
  return { remove: false, reason: 'terminal task but branch not pushed (unpushed work retained)' };
}

/** Minimal persisted-worker shape needed to decide worktree ownership. */
export interface WorktreeOwnerRecord {
  status?: string;
  worktreePath?: string;
  branch?: string;
  lastActivity?: number;
}

/**
 * Classify who owns a leftover worktree, matching persisted worker records by
 * worktree path or branch. A `waiting` worker counts as live only within the
 * TTL — past it, its abandoned worktree is reclaimable (terminal). Missing
 * records (e.g. aged out of the store's 24h TTL) mean a true orphan.
 */
export function classifyOwner(
  records: WorktreeOwnerRecord[],
  worktreePath: string,
  branch: string,
  now: number = Date.now(),
): WorktreeOwnerState {
  const owner = records.find(r =>
    (r.worktreePath && r.worktreePath === worktreePath) ||
    (r.branch && r.branch === branch));
  if (!owner) return 'orphan';
  if (owner.status === 'working' || owner.status === 'stale') return 'live';
  if (owner.status === 'waiting') {
    const age = now - (owner.lastActivity ?? 0);
    return age < WAITING_WORKTREE_TTL_MS ? 'live' : 'terminal';
  }
  return 'terminal'; // done / error / idle
}

/**
 * Compute the set of "main" git repos whose worktrees the sweep must enumerate.
 * This is the blind-spot fix: the old sweep only looked at `project/*`, missing
 * the buildd self-repo (BUILDD_DIR) and its role checkouts (roles/*) where the
 * leaking builder worktrees actually live. Pure — fs access is injected.
 */
export function candidateRepoRoots(opts: {
  builddDir: string;
  projectDir: string;
  isGitRepo: (dir: string) => boolean;
  listDir: (dir: string) => string[];
  joinPath: (...parts: string[]) => string;
}): string[] {
  const { builddDir, projectDir, isGitRepo, listDir, joinPath } = opts;
  const repos = new Set<string>();
  if (isGitRepo(builddDir)) repos.add(builddDir);
  for (const d of listDir(joinPath(builddDir, 'roles'))) {
    const p = joinPath(builddDir, 'roles', d);
    if (isGitRepo(p)) repos.add(p);
  }
  for (const d of listDir(projectDir)) {
    const p = joinPath(projectDir, d);
    if (isGitRepo(p)) repos.add(p);
  }
  return [...repos];
}
