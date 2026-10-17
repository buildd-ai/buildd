/**
 * The kernel's live GitHub reads (R2, docs/specs/workflow-state-kernel.md §2):
 * a webhook payload or a runner report is a hint; the reducer acts on a read
 * the kernel took after the hint arrived.
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { githubApi } from '@/lib/github';
import { isBaseDiffEquivalent, isContentEquivalentHead, readReviewedDelta } from '@/lib/pr-content-equivalence';
import { FAILING_CONCLUSIONS, PASSING_CONCLUSIONS, listAllCheckRuns } from '@/lib/ci-verdict';
import { latestRunPerName } from '@/lib/auto-merge-bound';
import type { LivePr } from './commands';
import type { GithubFactReader } from './facts';
import type { BaseDeltaFact } from './base-delta';
import { sqlWhere } from '@buildd/core/db/relational-sql';

interface GithubPull {
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  updated_at?: string | null;
  mergeable_state?: string | null;
  draft?: boolean;
  merged_by?: { login?: string | null } | null;
  head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string };
}

export function toLivePr(pr: GithubPull | null | undefined): LivePr | null {
  const headSha = pr?.head?.sha;
  if (!pr || !headSha) return null;
  return {
    state: pr.state === 'closed' ? 'closed' : 'open',
    merged: pr.merged === true || !!pr.merged_at,
    headSha,
    headRepoFullName: pr.head?.repo?.full_name ?? null,
    ...(pr.head?.ref ? { headRef: pr.head.ref } : {}),
    baseRef: pr.base?.ref ?? null,
    mergedAt: pr.merged_at ?? null,
    mergeCommitSha: pr.merge_commit_sha ?? null,
    updatedAt: pr.updated_at ?? null,
    mergeableState: pr.mergeable_state ?? null,
    ...(pr.draft ? { draft: true } : {}),
    // Who merged it, as GitHub says (§13.13 rule 10: an external merge records its merger).
    ...(pr.merged_by?.login ? { mergedBy: pr.merged_by.login } : {}),
  };
}

// One rule with the landing door (ci-verdict.ts), so the two cannot drift.
const PASSING = PASSING_CONCLUSIONS;

/** §10.5 revalidation of a CI repair: green only when every suite completed and none failed. */
export function ciGreenFromSuites(suites: Array<{ status?: string; conclusion?: string | null }> | null | undefined): boolean | null {
  if (!suites || suites.length === 0) return null;
  if (suites.some((x) => x.status !== 'completed')) return null;
  return suites.every((x) => PASSING.has(String(x.conclusion ?? '')));
}

const FAILING = FAILING_CONCLUSIONS;

/** A check run as the kernel reads it: enough to order re-runs and find the suite it belongs to. */
export interface CheckRunRow {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  check_suite?: { id?: number } | null;
}

/**
 * 6900a317: the runs that still speak for the head. A workflow triggered twice on one
 * commit (a re-run, or a PR-body edit re-running a gate) leaves the first run's failure
 * attached to the same SHA beside the run that replaced it; GitHub's merge box and the
 * landing door (latestRunPerName) read the newest run per check name, and so does the
 * kernel. Unorderable same-name runs are both kept, so an unorderable failure still counts.
 */
export function currentCheckRuns<T extends CheckRunRow>(runs: T[]): T[] {
  const rows = runs.map((r) => ({ ...r, name: String(r.name ?? 'unnamed'), status: String(r.status ?? ''), conclusion: r.conclusion ?? null, __row: r }));
  return latestRunPerName(rows).map((r) => r.__row);
}

/**
 * The suites still to count: a suite every one of whose runs a newer same-name run
 * replaced (in another suite) no longer decides anything. A suite with no runs, or any
 * run still current, stays: a startup failure has no runs and is still red. Without a
 * complete run read nothing is dropped (fails closed).
 */
export function currentSuites<S extends { id?: number }>(suites: S[], runs: CheckRunRow[] | null): S[] {
  if (!runs) return suites;
  const current = new Set(currentCheckRuns(runs));
  return suites.filter((s) => {
    const own = runs.filter((r) => s.id != null && r.check_suite?.id === s.id);
    return own.length === 0 || own.some((r) => current.has(r));
  });
}

/** §6.10: which check runs fail on a commit, and whether all of them finished. null = no runs. Superseded re-runs are dropped first. */
export function checkRunsSummary(runs: CheckRunRow[] | null | undefined): { complete: boolean; failing: string[] } | null {
  if (!runs || runs.length === 0) return null;
  const live = currentCheckRuns(runs);
  return {
    complete: live.every((r) => r.status === 'completed'),
    failing: live.filter((r) => r.status === 'completed' && FAILING.has(String(r.conclusion ?? ''))).map((r) => String(r.name ?? 'unnamed')),
  };
}

/** The distinct names of failed workflow runs and check runs. */
export function failingNames(rows: Array<{ name?: string | null; conclusion?: string | null }>): string[] {
  return [...new Set(rows.filter((r) => FAILING.has(String(r.conclusion ?? '')) && r.name).map((r) => String(r.name)))];
}

/**
 * The kernel's GitHub reader. `timeoutMs` bounds every call it makes (an AbortSignal on each
 * request): a caller with a budget, like the fast heal (kernel-heal.ts), never waits on a slow
 * GitHub past it. A timed-out read reads as failed (null), like any other failed read.
 */
export function githubReader(installationId: number, rawApi: typeof githubApi = githubApi, opts: { timeoutMs?: number } = {}): GithubFactReader {
  const timeoutMs = opts.timeoutMs;
  const api: typeof githubApi = timeoutMs
    ? (id, path, init = {}) => rawApi(id, path, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    : rawApi;
  return {
    async readPr(repoFullName, prNumber) {
      try {
        return toLivePr(await api(installationId, `/repos/${repoFullName}/pulls/${prNumber}`) as GithubPull);
      } catch (err) {
        console.warn(`[workflow] live read of ${repoFullName}#${prNumber} failed:`, err);
        return null;
      }
    },
    async statusOf(repoFullName, sha, context) {
      try {
        // The combined status lists the latest status per context.
        const data = await api(installationId, `/repos/${repoFullName}/commits/${sha}/status?per_page=100`) as { statuses?: Array<{ context?: string; state?: string; description?: string | null }> } | null;
        const st = (data?.statuses ?? []).find((x) => x.context === context);
        return st?.state ? { state: st.state, description: st.description ?? '' } : null;
      } catch {
        return null;
      }
    },
    async ciGreen(repoFullName, headSha) {
      try {
        const [data, runs] = await Promise.all([
          api(installationId, `/repos/${repoFullName}/commits/${headSha}/check-suites`) as Promise<{ check_suites?: Array<{ id?: number; status?: string; conclusion?: string | null }> } | null>,
          // The runs only ever drop a superseded suite; an unreadable or partial list drops nothing.
          listAllCheckRuns<CheckRunRow>(api, installationId, repoFullName, headSha).catch(() => null),
        ]);
        const suites = data?.check_suites;
        return ciGreenFromSuites(suites ? currentSuites(suites, runs?.complete ? runs.items : null) : suites);
      } catch {
        return null;
      }
    },
    async checkRuns(repoFullName, sha) {
      try {
        const read = await listAllCheckRuns<CheckRunRow>(api, installationId, repoFullName, sha);
        const summary = checkRunsSummary(read.items);
        // A read short of total_count is unknown, never "complete".
        return summary && !read.complete ? { ...summary, complete: false } : summary;
      } catch {
        return null;
      }
    },
    async failingChecks(repoFullName, headSha) {
      try {
        const [runs, checks] = await Promise.all([
          api(installationId, `/repos/${repoFullName}/actions/runs?head_sha=${headSha}&per_page=50`) as Promise<{ workflow_runs?: Array<{ name?: string | null; conclusion?: string | null }> } | null>,
          listAllCheckRuns<{ name?: string | null; conclusion?: string | null }>(api, installationId, repoFullName, headSha),
        ]);
        return failingNames([...(runs?.workflow_runs ?? []), ...checks.items]);
      } catch {
        return null;
      }
    },
    async branchHead(repoFullName, ref) {
      try {
        const data = await api(installationId, `/repos/${repoFullName}/branches/${ref}`) as { commit?: { sha?: string } } | null;
        return data?.commit?.sha ?? null;
      } catch {
        return null;
      }
    },
    async branchExists(repoFullName, ref) {
      try {
        const b = await api(installationId, `/repos/${repoFullName}/branches/${ref.split('/').map(encodeURIComponent).join('/')}`) as { name?: string } | null;
        return b ? true : null;
      } catch (err) {
        // Only GitHub's own "not found" says the branch is gone; anything else is unknown.
        return /\b404\b/.test(err instanceof Error ? err.message : String(err)) ? false : null;
      }
    },
    async contains(repoFullName, ancestorSha, headSha) {
      try {
        const cmp = await api(installationId, `/repos/${repoFullName}/compare/${ancestorSha}...${headSha}`) as { status?: string } | null;
        return cmp?.status === 'ahead' || cmp?.status === 'identical';
      } catch {
        return false;
      }
    },
    async changedPaths(repoFullName, fromSha, toSha) {
      const cmp = await api(installationId, `/repos/${repoFullName}/compare/${fromSha}...${toSha}`).catch(() => null) as { files?: unknown } | null;
      const files = names(cmp?.files);
      // A list at the compare cap may be cut: unread, not "these and no others".
      if (!files || files.length >= COMPARE_FILE_LIMIT) return null;
      // A renamed file counts under its old name too: a finding was anchored on that one.
      const previous = (cmp!.files as Array<{ previous_filename?: unknown }>).map((f) => f?.previous_filename).filter((n): n is string => typeof n === 'string');
      return [...new Set([...files, ...previous])];
    },
    async baseDelta(repoFullName, prNumber, headSha, baseRef) {
      return readBaseDelta((path) => api(installationId, path), repoFullName, prNumber, headSha, baseRef);
    },
    async contentEquivalent(repoFullName, baseRef, fromSha, toSha) {
      // isContentEquivalentHead fails closed: an unreadable compare is "not equivalent".
      const r = await isContentEquivalentHead({ installationId, repoFullName, baseRef, fromSha, toSha, api });
      return r.equivalent;
    },
    async reviewedDelta(repoFullName, baseRef, fromSha, toSha) {
      // readReviewedDelta fails closed: unreadable or possibly cut is null, and the round is a full review.
      return readReviewedDelta({ installationId, repoFullName, baseRef, fromSha, toSha, api });
    },
    async baseDiffEquivalent(repoFullName, fromBase, toBase, headSha) {
      const r = await isBaseDiffEquivalent({ installationId, repoFullName, fromBase, toBase, sha: headSha, api });
      return r.equivalent;
    },
  };
}

/** The compare API lists at most this many files; a list that long may be cut. */
const COMPARE_FILE_LIMIT = 300;
const PR_FILES_PAGE = 100;
const PR_FILES_MAX_PAGES = 3;

const names = (files: unknown): string[] | null => (Array.isArray(files)
  ? files.map((f) => (f as { filename?: unknown })?.filename).filter((n): n is string => typeof n === 'string')
  : null);

/**
 * S15's base delta (base-delta.ts), read live: `compare/{head}...{base}` gives the
 * commits the base gained since the head's merge-base (`ahead_by`) and the files
 * they changed; the PR's own files come from `pulls/{n}/files`. A list that may
 * be truncated, or a read that fails, is null on that side.
 */
export async function readBaseDelta(
  get: (path: string) => Promise<unknown>,
  repoFullName: string, prNumber: number, headSha: string, baseRef: string,
): Promise<BaseDeltaFact> {
  const cmp = await get(`/repos/${repoFullName}/compare/${headSha}...${encodeURIComponent(baseRef)}`).catch(() => null) as { ahead_by?: number; files?: unknown } | null;
  const baseCommits = typeof cmp?.ahead_by === 'number' ? cmp.ahead_by : null;
  let baseFiles = names(cmp?.files);
  if (baseFiles && baseFiles.length >= COMPARE_FILE_LIMIT) baseFiles = null;
  const prFiles: string[] = [];
  for (let page = 1; page <= PR_FILES_MAX_PAGES; page++) {
    const batch = names(await get(`/repos/${repoFullName}/pulls/${prNumber}/files?per_page=${PR_FILES_PAGE}&page=${page}`).catch(() => null));
    if (!batch) return { baseCommits, baseFiles, prFiles: null };
    prFiles.push(...batch);
    if (batch.length < PR_FILES_PAGE) return { baseCommits, baseFiles, prFiles };
  }
  // Every page was full: there may be more than we read.
  return { baseCommits, baseFiles, prFiles: null };
}

export interface WorkspaceRepo {
  installationId: number;
  repoFullName: string;
  gitConfig: unknown;
}

export async function workspaceRepo(workspaceId: string): Promise<WorkspaceRepo | null> {
  const ws = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, workspaceId)),
    columns: { id: true, gitConfig: true },
    with: { githubRepo: { columns: { fullName: true }, with: { installation: { columns: { installationId: true } } } } },
  });
  const installationId = ws?.githubRepo?.installation?.installationId;
  const repoFullName = ws?.githubRepo?.fullName;
  return installationId && repoFullName ? { installationId, repoFullName, gitConfig: ws?.gitConfig ?? null } : null;
}
