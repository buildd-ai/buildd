/**
 * The kernel's live GitHub reads (R2, docs/specs/workflow-state-kernel.md §2):
 * a webhook payload or a runner report is a hint; the reducer acts on a read
 * the kernel took after the hint arrived.
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { githubApi } from '@/lib/github';
import type { LivePr } from './commands';
import type { GithubFactReader } from './facts';

interface GithubPull {
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  updated_at?: string | null;
  head?: { sha?: string; repo?: { full_name?: string } | null };
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
    baseRef: pr.base?.ref ?? null,
    mergedAt: pr.merged_at ?? null,
    mergeCommitSha: pr.merge_commit_sha ?? null,
    updatedAt: pr.updated_at ?? null,
  };
}

const PASSING = new Set(['success', 'neutral', 'skipped']);

/** §10.5 revalidation of a CI repair: green only when every suite completed and none failed. */
export function ciGreenFromSuites(suites: Array<{ status?: string; conclusion?: string | null }> | null | undefined): boolean | null {
  if (!suites || suites.length === 0) return null;
  if (suites.some((x) => x.status !== 'completed')) return null;
  return suites.every((x) => PASSING.has(String(x.conclusion ?? '')));
}

const FAILING = new Set(['failure', 'timed_out', 'startup_failure']);

/** The distinct names of failed workflow runs and check runs. */
export function failingNames(rows: Array<{ name?: string | null; conclusion?: string | null }>): string[] {
  return [...new Set(rows.filter((r) => FAILING.has(String(r.conclusion ?? '')) && r.name).map((r) => String(r.name)))];
}

export function githubReader(installationId: number, api: typeof githubApi = githubApi): GithubFactReader {
  return {
    async readPr(repoFullName, prNumber) {
      try {
        return toLivePr(await api(installationId, `/repos/${repoFullName}/pulls/${prNumber}`) as GithubPull);
      } catch (err) {
        console.warn(`[workflow] live read of ${repoFullName}#${prNumber} failed:`, err);
        return null;
      }
    },
    async ciGreen(repoFullName, headSha) {
      try {
        const data = await api(installationId, `/repos/${repoFullName}/commits/${headSha}/check-suites`) as { check_suites?: Array<{ status?: string; conclusion?: string | null }> } | null;
        return ciGreenFromSuites(data?.check_suites);
      } catch {
        return null;
      }
    },
    async failingChecks(repoFullName, headSha) {
      try {
        const [runs, checks] = await Promise.all([
          api(installationId, `/repos/${repoFullName}/actions/runs?head_sha=${headSha}&per_page=50`) as Promise<{ workflow_runs?: Array<{ name?: string | null; conclusion?: string | null }> } | null>,
          api(installationId, `/repos/${repoFullName}/commits/${headSha}/check-runs?per_page=100`) as Promise<{ check_runs?: Array<{ name?: string | null; conclusion?: string | null }> } | null>,
        ]);
        return failingNames([...(runs?.workflow_runs ?? []), ...(checks?.check_runs ?? [])]);
      } catch {
        return null;
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
  };
}

export interface WorkspaceRepo {
  installationId: number;
  repoFullName: string;
  gitConfig: unknown;
}

export async function workspaceRepo(workspaceId: string): Promise<WorkspaceRepo | null> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { id: true, gitConfig: true },
    with: { githubRepo: { columns: { fullName: true }, with: { installation: { columns: { installationId: true } } } } },
  });
  const installationId = ws?.githubRepo?.installation?.installationId;
  const repoFullName = ws?.githubRepo?.fullName;
  return installationId && repoFullName ? { installationId, repoFullName, gitConfig: ws?.gitConfig ?? null } : null;
}
