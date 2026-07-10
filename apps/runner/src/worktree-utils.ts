/**
 * Worktree utility functions for the runner.
 *
 * Extracted from workers.ts for testability.
 */

/**
 * Resolve the git base ref for a new worktree.
 *
 * If `context.baseBranch` is set (e.g., from a retry task in the Ralph loop),
 * the worktree will be based on that branch instead of the default branch.
 * This preserves work from previous attempts.
 *
 * @param defaultBranch - The workspace's default branch (e.g., 'main')
 * @param context - The task context, which may contain `baseBranch`
 * @returns A git ref like `origin/main` or `origin/buildd/abc-fix-tests`
 */
export function resolveWorktreeBase(
  defaultBranch: string,
  context: Record<string, unknown> | undefined | null,
): string {
  const baseBranch = context?.baseBranch;
  if (baseBranch && typeof baseBranch === 'string' && baseBranch.length > 0) {
    return `origin/${baseBranch}`;
  }
  return `origin/${defaultBranch}`;
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
