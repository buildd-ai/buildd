/**
 * Verify a PR that reaches a worker row without going through create_pr:
 *
 *   - self-report: `prUrl` / `prNumber` in the worker PATCH body
 *   - the `pr_required` fallback: a `#N` the task text names, adopted at
 *     completion when it is merged or carries the worker's last commit
 *
 * Both used to record the PR with no check at all. They now pass the same
 * three questions create_pr asks: is it in the workspace's linked repo, does
 * the task own its head (pr-ownership.ts), and does its base satisfy the
 * mission integration rule (mission-base-guard.ts, called, not copied).
 *
 * Without a GitHub App installation nothing can be read, so a self-report is
 * accepted as before (`verified: false`); the fallback never runs without one.
 * A GitHub read failure refuses: unlike create_pr there is no caller-supplied
 * head to fall back on, and the rest of the PATCH still applies.
 */
import { db } from '@buildd/core/db';
import { githubRepos, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { loadMissionBaseGuard } from '@/lib/mission-base-guard';
import { ensureIntegrationBaseForTaskPr } from '@/lib/mission-integration-branch';
import { collectRetryLineage } from '@/lib/retry-pr-supersession';
import { verifyPrOwnership, type PrOwnershipTask } from './pr-ownership';
import { repoProtectedBranches } from './github';

export interface ReportedPrWorker {
  id: string;
  branch: string | null;
  workspaceId: string;
  taskId: string | null;
}

export interface ReportedPrTask extends PrOwnershipTask {
  missionId?: string | null;
  taskClass?: string | null;
}

export interface GithubPrView {
  number?: number;
  html_url?: string;
  head?: { ref?: string | null; sha?: string | null } | null;
  base?: { ref?: string | null } | null;
  merged?: boolean;
}

export type ReportedPrVerdict =
  | { accept: true; verified: true; pr: { number: number; url: string; baseRef: string | null; view: GithubPrView } }
  | { accept: true; verified: false; pr: { number: number | null; url: string | null } }
  | { accept: false; reasonCode: 'pr_outside_linked_repo' | 'pr_unreadable' | 'head_not_owned' | 'protected_head' | 'mission_base'; error: string };

function numberFromUrl(url: string | null | undefined): number | null {
  const m = url ? /\/pull\/(\d+)(?:\D|$)/.exec(url) : null;
  return m ? Number(m[1]) : null;
}

export async function verifyReportedWorkerPr(args: {
  worker: ReportedPrWorker;
  task: ReportedPrTask | null;
  reported: { url?: string | null; number?: number | null };
  /** A PR already read from the linked repo (the fallback has one). */
  view?: GithubPrView;
}): Promise<ReportedPrVerdict> {
  const { worker, task } = args;
  const url = args.reported.url ?? null;
  const number = args.reported.number ?? numberFromUrl(url);

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, worker.workspaceId) });
  const repo = ws?.githubRepoId
    ? await db.query.githubRepos.findFirst({ where: eq(githubRepos.id, ws.githubRepoId), with: { installation: true } })
    : undefined;
  if (!ws || !repo?.installation) return { accept: true, verified: false, pr: { number, url } };

  const outside = { accept: false as const, reasonCode: 'pr_outside_linked_repo' as const, error: `The reported PR is not a pull request in this workspace's repository (${repo.fullName}).` };
  if (!number) return outside;
  if (url && !url.toLowerCase().includes(`/${repo.fullName.toLowerCase()}/pull/${number}`)) return outside;

  let view = args.view;
  if (!view) {
    try {
      view = await githubApi(repo.installation.installationId, `/repos/${repo.fullName}/pulls/${number}`) as GithubPrView;
    } catch {
      return { accept: false, reasonCode: 'pr_unreadable', error: `PR #${number} could not be read from ${repo.fullName}.` };
    }
  }
  const head = typeof view?.head?.ref === 'string' ? view.head.ref : null;
  if (!head) return { accept: false, reasonCode: 'pr_unreadable', error: `PR #${number} in ${repo.fullName} has no readable head.` };

  const ownership = await verifyPrOwnership({
    head,
    prNumber: number,
    workerBranch: worker.branch,
    task,
    protectedBranches: repoProtectedBranches(ws, repo.defaultBranch),
  }, collectRetryLineage);
  if (!ownership.owned) return { accept: false, reasonCode: ownership.reasonCode, error: ownership.error };

  const baseRef = typeof view.base?.ref === 'string' ? view.base.ref : null;
  const guard = await loadMissionBaseGuard({
    task: task ? { title: task.title ?? null, taskClass: task.taskClass ?? null, missionId: task.missionId ?? null, context: task.context } : null,
    head,
  });
  if (guard.enforced) {
    // Same escape hatch as every other door: an integration branch that
    // cannot exist in this repo is not a base to hold the PR to.
    let integrationBaseMissing = false;
    if (task?.missionId && guard.integrationBase) {
      const ready = await ensureIntegrationBaseForTaskPr({
        missionId: task.missionId,
        integrationBase: guard.integrationBase,
        taskTitle: task.title ?? '',
        workspaceId: worker.workspaceId,
        taskId: worker.taskId,
        workerId: worker.id,
      });
      integrationBaseMissing = !ready.usable;
    }
    const refusal = integrationBaseMissing ? null : guard.refusal(baseRef, { prNumber: number, action: 'adopt' });
    if (refusal) return { accept: false, reasonCode: 'mission_base', error: refusal.error };
  }

  return {
    accept: true,
    verified: true,
    pr: { number, url: typeof view.html_url === 'string' ? view.html_url : (url ?? `https://github.com/${repo.fullName}/pull/${number}`), baseRef, view },
  };
}
