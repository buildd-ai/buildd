/**
 * Attach a PR to a task that was closed without a worker.
 *
 * A task closed by hand (`update_task status=completed`) has no worker row, so
 * nothing maps it to the PR that actually delivered it: the mission page shows
 * no PRs and `canCompleteMission` cannot see the delivery. This records the
 * mapping the same way adoption does for a PR buildd did not open — a
 * placeholder worker with `runner: 'external'` carrying the PR — so every
 * surface that reads "the worker that owns this PR" sees it without a second
 * code path. The PR is verified against the workspace's repo through the
 * GitHub App before anything is written.
 */

import { db } from '@buildd/core/db';
import { tasks, workers, githubRepos } from '@buildd/core/db/schema';
import type { TaskResult } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { githubApi } from './github';
import { insertPrOwnerWorker, type AdoptablePr, type PrMergeState } from './pr-review-request';

const PR_URL = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/**
 * Resolve `{ prUrl?, prNumber? }` to a PR number in `repoFullName`.
 *
 * A URL must point at the workspace's own repo — attaching a PR from another
 * repo would claim a delivery this workspace never made. When both are given
 * they must agree.
 */
export function parsePrReference(
  input: { prUrl?: unknown; prNumber?: unknown },
  repoFullName: string,
): { prNumber: number } | { error: string } {
  let fromUrl: number | null = null;
  if (input.prUrl !== undefined && input.prUrl !== null) {
    const match = typeof input.prUrl === 'string' ? PR_URL.exec(input.prUrl.trim()) : null;
    if (!match) return { error: 'prUrl must be a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<n>)' };
    if (match[1].toLowerCase() !== repoFullName.toLowerCase()) {
      return { error: `prUrl points at ${match[1]}, but this task's workspace is linked to ${repoFullName}` };
    }
    fromUrl = Number(match[2]);
  }

  let fromNumber: number | null = null;
  if (input.prNumber !== undefined && input.prNumber !== null) {
    const n = Number(input.prNumber);
    if (!Number.isInteger(n) || n <= 0) return { error: 'prNumber must be a positive integer' };
    fromNumber = n;
  }

  if (fromUrl !== null && fromNumber !== null && fromUrl !== fromNumber) {
    return { error: `prUrl names PR #${fromUrl} but prNumber is ${fromNumber}` };
  }
  const prNumber = fromUrl ?? fromNumber;
  if (prNumber === null) return { error: 'prUrl or prNumber is required' };
  return { prNumber };
}

/** The GitHub repo + App installation behind a workspace, or null if unlinked. */
export async function resolveWorkspaceGithubRepo(workspace: {
  githubRepoId?: string | null;
  githubInstallationId?: string | null;
}): Promise<{ fullName: string; installationId: number } | null> {
  if (!workspace.githubRepoId || !workspace.githubInstallationId) return null;
  const repo = await db.query.githubRepos.findFirst({
    where: eq(githubRepos.id, workspace.githubRepoId),
    with: { installation: true },
  });
  if (!repo?.installation) return null;
  return { fullName: repo.fullName as string, installationId: repo.installation.installationId as number };
}

export type AttachPrOutcome =
  | { ok: true; alreadyAttached: boolean; workerId: string; prNumber: number; prUrl: string; prState: 'open' | 'merged' | 'closed'; result: TaskResult }
  | { ok: false; status: number; error: string };

/**
 * Verify `prNumber` exists in the repo and map it to `task`.
 *
 * Idempotent: attaching the PR this task already owns returns the existing
 * worker. Refused when another task owns the PR (the delivery belongs to it) or
 * when this task already records a different PR.
 */
export async function attachPrToTask(params: {
  task: { id: string; workspaceId: string; result: unknown };
  repo: { fullName: string; installationId: number };
  prNumber: number;
  accountId?: string | null;
}): Promise<AttachPrOutcome> {
  const { task, repo, prNumber, accountId } = params;
  const existingResult = (task.result ?? {}) as TaskResult;

  if (typeof existingResult.prNumber === 'number' && existingResult.prNumber !== prNumber) {
    return {
      ok: false,
      status: 409,
      error: `Task already records PR #${existingResult.prNumber}; refusing to replace it with #${prNumber}`,
    };
  }

  const owner = await db.query.workers.findFirst({
    where: and(eq(workers.workspaceId, task.workspaceId), eq(workers.prNumber, prNumber)),
    columns: { id: true, taskId: true, prUrl: true },
  });
  if (owner && owner.taskId !== task.id) {
    return {
      ok: false,
      status: 409,
      error: `PR #${prNumber} already belongs to task ${owner.taskId ?? '(none)'} in this workspace`,
    };
  }

  // Read the PR before writing anything — a wrong number must leave no trace.
  let pr: (AdoptablePr & PrMergeState) | null;
  try {
    pr = await githubApi(repo.installationId, `/repos/${repo.fullName}/pulls/${prNumber}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: message.includes('404') ? 404 : 502,
      error: `Could not read PR #${prNumber} on ${repo.fullName}: ${message}`,
    };
  }
  if (!pr?.number) return { ok: false, status: 404, error: `PR #${prNumber} not found on ${repo.fullName}` };

  const prState = pr.merged === true || pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';

  let workerId = owner?.id ?? null;
  if (!workerId) {
    const inserted = await insertPrOwnerWorker({
      workspaceId: task.workspaceId,
      taskId: task.id,
      installationId: repo.installationId,
      repoFullName: repo.fullName,
      pr,
      accountId,
      name: `pr-${prNumber}-attached`,
    });
    if (!inserted) return { ok: false, status: 500, error: `Could not attach PR #${prNumber} (worker insert failed)` };
    workerId = inserted.id;
  }

  const result: TaskResult = {
    ...existingResult,
    prUrl: pr.html_url,
    prNumber,
    ...(existingResult.branch ? {} : pr.head?.ref ? { branch: pr.head.ref } : {}),
  };
  await db.update(tasks).set({ result, updatedAt: new Date() }).where(eq(tasks.id, task.id));

  return { ok: true, alreadyAttached: Boolean(owner), workerId, prNumber, prUrl: pr.html_url, prState, result };
}
