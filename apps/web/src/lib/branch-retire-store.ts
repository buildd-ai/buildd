/**
 * Branch retirement, the I/O half (branch-retire.ts is the decision).
 *
 * `retireBranchIfDead` reads one branch's facts from GitHub and buildd's own
 * rows, asks `decideBranchRetire`, and deletes the ref when the answer is
 * delete. It is called from three places, all through the same keep-rules:
 *
 *   - a PR closing, merged or not (`pr.close_delivered`): a superseded PR, a
 *     `close_pr`, a finished release candidate, a merged PR GitHub did not clean up;
 *   - a task ending (`task.terminal`): the branches its workers pushed;
 *   - `sweepDeadBranches`, once a day from the hourly PR sweep: the floor for
 *     whatever escaped both (a lost webhook, a PR-less branch that had to age,
 *     a mission that ended later than its last PR).
 *
 * A workspace turns it off with `gitConfig.branchCleanup: 'off'`. Every read
 * that fails keeps the branch: nothing here deletes on a guess.
 */
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { matchesCandidatePattern, releaseCandidatePolicy } from '@buildd/core/release-config-shape';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { githubApi } from '@/lib/github';
import { workspaceRepoMatches } from '@/lib/repo-scope';
import { decideBranchRetire, missionIdPrefixOf, type BranchFacts, type BranchOwner, type BranchVerdict, type EndedPr } from '@/lib/branch-retire';

export type GithubCall = (installationId: number, path: string, init?: RequestInit) => Promise<unknown>;

/** What buildd's own rows say about a branch. */
export interface BranchOwnership { owner: BranchOwner | null; referencedByLiveTask: boolean }

export interface RepoScope {
  repoFullName: string;
  installationId: number;
  /** Trunk names beyond the repo's default branch: each workspace's `gitConfig.defaultBranch`. */
  trunkBranches: string[];
  workspaceIds: string[];
  /** Release-candidate head patterns (`release/v*`) from any workspace on the repo. */
  candidatePatterns: string[];
}

export interface BranchRetireDeps {
  api: GithubCall;
  ownership: (scope: RepoScope, branch: string) => Promise<BranchOwnership>;
  now: () => Date;
}

export type RetireOutcome = BranchVerdict & { deleted: boolean };

const defaultDeps = (): BranchRetireDeps => ({ api: githubApi, ownership: loadBranchOwnership, now: () => new Date() });

const statusOf = (err: unknown): number | null => {
  const m = (err instanceof Error ? err.message : String(err)).match(/GitHub API error: (\d{3})/);
  return m ? Number(m[1]) : null;
};

/** A ref path segment-encoded: `buildd/x` stays a path, `#`/`%` are escaped. */
export const encodeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/** One branch: read, decide, delete if dead. Never throws for a GitHub read; a failed read keeps the branch. */
export async function retireBranchIfDead(
  scope: RepoScope, branch: string, deps: BranchRetireDeps = defaultDeps(),
  known?: { defaultBranch?: string | null; openHeads?: ReadonlySet<string>; openBases?: ReadonlySet<string> },
): Promise<RetireOutcome> {
  const { api } = deps;
  const repo = scope.repoFullName;
  const owner = repo.split('/')[0];
  const kept = (reason: Extract<BranchVerdict, { action: 'keep' }>['reason']): RetireOutcome => ({ action: 'keep', reason, deleted: false });

  // Cheap rules before any GitHub read.
  if (branch === 'dev' || branch === 'main' || scope.trunkBranches.includes(branch) || branch === known?.defaultBranch) return kept('trunk');
  if (known?.openHeads?.has(branch)) return kept('open_pr');
  if (known?.openBases?.has(branch)) return kept('open_pr_based_on_it');
  const ownership = await deps.ownership(scope, branch);
  if (!ownership.owner) return kept('not_buildd_branch');

  let defaultBranch = known?.defaultBranch ?? null;
  try {
    if (!defaultBranch) defaultBranch = ((await api(scope.installationId, `/repos/${repo}`)) as { default_branch?: string } | null)?.default_branch ?? null;
    const b = await api(scope.installationId, `/repos/${repo}/branches/${encodeRef(branch)}`).catch((err) => {
      if (statusOf(err) === 404) return null;
      throw err;
    }) as { protected?: boolean; commit?: { sha?: string; commit?: { committer?: { date?: string } } } } | null;
    if (!b?.commit?.sha) return kept('gone');
    const tipSha = b.commit.sha;
    const committed = b.commit.commit?.committer?.date;

    const heads = (await api(scope.installationId, `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=50`)) as Array<{
      number: number; state: string; merged_at?: string | null; closed_at?: string | null; head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
    }> | null;
    const own = (heads ?? []).filter((p) => p.head?.ref === branch && (p.head?.repo?.full_name ?? repo).toLowerCase() === repo.toLowerCase());
    const bases = (await api(scope.installationId, `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=1`)) as Array<{ number: number }> | null;

    const facts: BranchFacts = {
      branch,
      tipSha,
      tipCommittedAt: committed ? new Date(committed) : null,
      isProtected: b.protected === true,
      trunkBranches: [...scope.trunkBranches, ...(defaultBranch ? [defaultBranch] : [])],
      openPrsAsHead: own.filter((p) => p.state === 'open').map((p) => p.number),
      openPrsAsBase: (bases ?? []).map((p) => p.number),
      endedPrs: own.filter((p) => p.state !== 'open').map((p): EndedPr => ({
        number: p.number, merged: !!p.merged_at, headSha: p.head?.sha ?? '', endedAt: p.closed_at ? new Date(p.closed_at) : null,
      })),
      tipInTrunk: null,
      owner: ownership.owner,
      referencedByLiveTask: ownership.referencedByLiveTask,
    };
    let verdict = decideBranchRetire(facts, deps.now());
    // Only when it could change the answer: is everything on the branch already in trunk?
    if (verdict.action === 'keep' && defaultBranch && ['unshipped_commits_after_pr', 'no_pr_young', 'no_pr_not_task_branch'].includes(verdict.reason)) {
      const cmp = (await api(scope.installationId, `/repos/${repo}/compare/${encodeRef(defaultBranch)}...${tipSha}`)) as { status?: string } | null;
      facts.tipInTrunk = cmp?.status === 'behind' || cmp?.status === 'identical';
      verdict = decideBranchRetire(facts, deps.now());
    }
    if (verdict.action === 'keep') return { ...verdict, deleted: false };

    try {
      await api(scope.installationId, `/repos/${repo}/git/refs/heads/${encodeRef(branch)}`, { method: 'DELETE' });
    } catch (err) {
      const s = statusOf(err);
      // 404 / 422: already gone (delete-branch-on-merge, or another path got there first).
      if (s !== 404 && s !== 422) throw err;
    }
    return { ...verdict, deleted: true };
  } catch (err) {
    console.warn(`[branch-retire] ${repo}:${branch} kept, read or delete failed:`, err instanceof Error ? err.message : err);
    return kept('unreadable');
  }
}

// ── Scope and ownership (buildd's rows) ─────────────────────────────────────

/** Every workspace on a repo that has not turned cleanup off, or null when none. */
export async function repoScope(repoFullName: string, installationId: number): Promise<RepoScope | null> {
  const rows = await db
    .select({ id: workspaces.id, gitConfig: workspaces.gitConfig, releaseConfig: workspaces.releaseConfig })
    .from(workspaces)
    .where(workspaceRepoMatches(repoFullName));
  if (rows.length === 0 || rows.some((w) => w.gitConfig?.branchCleanup === 'off')) return null;
  const patterns = rows.flatMap((w) => releaseCandidatePolicy(w.releaseConfig)?.branches ?? []);
  const trunks = rows.map((w) => w.gitConfig?.defaultBranch).filter((b): b is string => !!b);
  const prod = rows.map((w) => w.releaseConfig?.prodBranch).filter((b): b is string => !!b);
  return { repoFullName, installationId, workspaceIds: rows.map((w) => w.id), trunkBranches: [...new Set([...trunks, ...prod])], candidatePatterns: [...new Set(patterns)] };
}

const TERMINAL = [...TERMINAL_TASK_STATUSES];

export async function loadBranchOwnership(scope: RepoScope, branch: string): Promise<BranchOwnership> {
  const live = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(
      inArray(tasks.workspaceId, scope.workspaceIds),
      notInArray(tasks.status, TERMINAL),
      or(sql`${tasks.context}->>'headBranch' = ${branch}`, sql`${tasks.context}->>'baseBranch' = ${branch}`),
    ))
    .limit(1);
  const referencedByLiveTask = live.length > 0;

  if (scope.candidatePatterns.some((p) => matchesCandidatePattern(p, branch))) return { owner: { kind: 'release_candidate' }, referencedByLiveTask };

  const missionPrefix = missionIdPrefixOf(branch);
  const missionRows = await db
    .select({ status: missions.status })
    .from(missions)
    .where(and(
      inArray(missions.workspaceId, scope.workspaceIds),
      missionPrefix ? or(eq(missions.workingBranch, branch), sql`${missions.id}::text LIKE ${`${missionPrefix}%`}`) : eq(missions.workingBranch, branch),
    ));
  if (missionRows.length > 0 || branch.startsWith('mission/')) {
    return { owner: { kind: 'mission', missionStatuses: missionRows.map((m) => m.status) }, referencedByLiveTask };
  }

  // The claim route is the only writer of workers.branch: a row here means buildd made this branch.
  const owned = await db
    .select({ status: tasks.status })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(inArray(workers.workspaceId, scope.workspaceIds), eq(workers.branch, branch)));
  if (owned.length > 0) return { owner: { kind: 'task', taskStatuses: owned.map((t) => t.status) }, referencedByLiveTask };

  // A worker row can be pruned; the generated name still carries the task's id prefix.
  const id8 = branch.match(/^buildd\/([0-9a-f]{8})-/)?.[1];
  if (!id8) return { owner: null, referencedByLiveTask };
  const byPrefix = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(and(inArray(tasks.workspaceId, scope.workspaceIds), sql`${tasks.id}::text LIKE ${`${id8}%`}`));
  return { owner: { kind: 'task', taskStatuses: byPrefix.map((t) => t.status) }, referencedByLiveTask };
}

// ── Entry points ────────────────────────────────────────────────────────────

/** A PR closed (merged or not): its head, if buildd made it and nothing still needs it. */
export async function retireClosedPrBranch(
  e: { repoFullName: string; installationId: number | null; headRef: string | null; headRepoFullName: string | null },
  deps?: BranchRetireDeps,
): Promise<RetireOutcome | null> {
  if (!e.installationId || !e.headRef) return null;
  // A fork's branch is not ours to delete.
  if (e.headRepoFullName && e.headRepoFullName.toLowerCase() !== e.repoFullName.toLowerCase()) return null;
  const scope = await repoScope(e.repoFullName, e.installationId);
  if (!scope) return null;
  return retireBranchIfDead(scope, e.headRef, deps);
}

/** A task ended: every branch its workers checked out. */
export async function retireTaskBranches(taskId: string, deps?: BranchRetireDeps): Promise<RetireOutcome[]> {
  const task = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, taskId)),
    columns: { workspaceId: true },
    with: { workspace: { columns: { id: true }, with: { githubRepo: { columns: { fullName: true }, with: { installation: { columns: { installationId: true } } } } } } },
  });
  const ws = task?.workspace as { githubRepo?: { fullName?: string; installation?: { installationId?: number } | null } | null } | null | undefined;
  const repoFullName = ws?.githubRepo?.fullName;
  const installationId = ws?.githubRepo?.installation?.installationId;
  if (!repoFullName || !installationId) return [];
  const scope = await repoScope(repoFullName, installationId);
  if (!scope) return [];
  const rows = await db.selectDistinct({ branch: workers.branch }).from(workers).where(eq(workers.taskId, taskId));
  const out: RetireOutcome[] = [];
  for (const { branch } of rows) if (branch) out.push(await retireBranchIfDead(scope, branch, deps));
  return out;
}

export interface SweepResult { repos: number; listed: number; evaluated: number; deleted: number; kept: Record<string, number>; truncated: boolean }

/** Per repo per run: at most this many branches are evaluated, and this many deleted. */
export const SWEEP_MAX_EVALUATED = 300;
export const SWEEP_MAX_DELETED = 150;

/**
 * The floor: every buildd-made branch of every linked repo, through the same
 * keep-rules. Branches with an open PR (as head or base) are skipped from one
 * listing, so only candidates cost GitHub reads.
 */
export async function sweepDeadBranches(deps: BranchRetireDeps = defaultDeps()): Promise<SweepResult> {
  const repos = await db.query.workspaces.findMany({
    columns: { id: true },
    with: { githubRepo: { columns: { fullName: true, defaultBranch: true }, with: { installation: { columns: { installationId: true } } } } },
  });
  const seen = new Set<string>();
  const result: SweepResult = { repos: 0, listed: 0, evaluated: 0, deleted: 0, kept: {}, truncated: false };
  for (const w of repos) {
    const gr = w.githubRepo as { fullName?: string; defaultBranch?: string | null; installation?: { installationId?: number } | null } | null;
    const repo = gr?.fullName; const installationId = gr?.installation?.installationId;
    if (!repo || !installationId || seen.has(repo.toLowerCase())) continue;
    seen.add(repo.toLowerCase());
    try {
      const scope = await repoScope(repo, installationId);
      if (scope) await sweepRepo(scope, gr?.defaultBranch ?? null, deps, result);
    } catch (err) {
      console.warn(`[branch-retire] sweep of ${repo} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

export async function sweepRepo(scope: RepoScope, defaultBranch: string | null, deps: BranchRetireDeps, result: SweepResult): Promise<void> {
  const { repoFullName: repo, installationId } = scope;
  result.repos++;
  const names: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = (await deps.api(installationId, `/repos/${repo}/branches?per_page=100&page=${page}`)) as Array<{ name: string; protected?: boolean }> | null;
    if (!Array.isArray(batch) || batch.length === 0) break;
    names.push(...batch.filter((b) => !b.protected).map((b) => b.name));
    if (batch.length < 100) break;
  }
  result.listed += names.length;
  const openHeads = new Set<string>(); const openBases = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const batch = (await deps.api(installationId, `/repos/${repo}/pulls?state=open&per_page=100&page=${page}`)) as Array<{ head?: { ref?: string }; base?: { ref?: string } }> | null;
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const p of batch) { if (p.head?.ref) openHeads.add(p.head.ref); if (p.base?.ref) openBases.add(p.base.ref); }
    if (batch.length < 100) break;
  }
  let evaluated = 0; let deleted = 0;
  for (const name of names) {
    if (evaluated >= SWEEP_MAX_EVALUATED || deleted >= SWEEP_MAX_DELETED) { result.truncated = true; break; }
    const r = await retireBranchIfDead(scope, name, deps, { defaultBranch, openHeads, openBases });
    // Rules settled without a GitHub read do not count against the budget.
    if (!['trunk', 'open_pr', 'open_pr_based_on_it', 'not_buildd_branch'].includes(r.reason)) evaluated++;
    if (r.deleted) deleted++;
    else result.kept[r.reason] = (result.kept[r.reason] ?? 0) + 1;
  }
  result.evaluated += evaluated;
  result.deleted += deleted;
}
