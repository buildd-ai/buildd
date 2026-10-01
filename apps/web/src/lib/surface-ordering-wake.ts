/**
 * Closure-driven wakeup for surface merge ordering (conflict-aware-orchestration.md §3).
 *
 * When an earlier PR on a serialized surface closes, the PR that was waiting
 * behind it has no event of its own coming: its CI was already green when it
 * was deferred. This re-drives it through the door it would normally merge
 * through — `landPr` under landing `enforce`, otherwise the legacy unattended
 * auto-merge path with the same tier rules the check-suite handler applies.
 * Nothing waits in a session; a PR that still cannot land simply records why.
 */

import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, isNull, notInArray, or } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { resolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS } from '@/lib/merge-policy';
import { resolvePrRepo } from '@/lib/repo-scope';
import { TERMINAL_PR_LIFECYCLE } from '@/lib/dep-gate-contract';
import { WORKSPACE_INSTALLATION_WITH, pickWorkspaceRepoIdentity, installationIdForRepo } from '@/lib/workspace-installation';

const TERMINAL_LIFECYCLE = [...TERMINAL_PR_LIFECYCLE];

/**
 * The open buildd worker behind a PR and where its repo lives, or why there is
 * none. Shared with the deferred-refresh re-drive (lib/refresh-redrive.ts).
 */
export async function resolveOpenWorkerPr(workspaceId: string, prNumber: number) {
  const worker = await db.query.workers.findFirst({
    where: and(
      eq(workers.workspaceId, workspaceId),
      eq(workers.prNumber, prNumber),
      isNull(workers.mergedAt),
      or(isNull(workers.prLifecycleStatus), notInArray(workers.prLifecycleStatus, TERMINAL_LIFECYCLE)),
    ),
    orderBy: desc(workers.createdAt),
    columns: { id: true, taskId: true, prUrl: true, prBaseRef: true, workspaceId: true },
  });
  if (!worker) return { skip: 'no_open_worker' as const };

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), with: WORKSPACE_INSTALLATION_WITH });
  if (!workspace) return { skip: 'no_workspace' as const };

  const identity = pickWorkspaceRepoIdentity(workspace);
  const repo = resolvePrRepo({ prUrl: worker.prUrl, workspaceRepo: identity.fullName });
  if (!repo) return { skip: 'no_repo' as const };
  const installationId =
    (repo === identity.fullName ? identity.installationId : null)
    ?? (await installationIdForRepo(repo).catch(() => null))
    ?? identity.installationId;
  if (!installationId) return { skip: 'no_installation' as const };
  return { skip: null, worker, workspace, repo, installationId };
}

export async function redriveSurfaceWaiter(
  workspaceId: string,
  prNumber: number,
  /**
   * expectHeadSha: re-drive only this head. A different live head has events
   * of its own, so the caller's reason to re-drive is gone (`head_moved`).
   */
  opts: { expectHeadSha?: string } = {},
): Promise<string> {
  const resolved = await resolveOpenWorkerPr(workspaceId, prNumber);
  if (resolved.skip) return resolved.skip;
  const { worker, workspace, repo, installationId } = resolved;

  const pr = await githubApi(installationId, `/repos/${repo}/pulls/${prNumber}`);
  const headSha: string | null = typeof pr?.head?.sha === 'string' ? pr.head.sha : null;
  if (!headSha || pr?.state !== 'open' || pr?.merged === true || pr?.draft === true) return 'not_open';
  if (opts.expectHeadSha && headSha !== opts.expectHeadSha) return 'head_moved';

  const task = worker.taskId
    ? await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        with: { mission: { columns: RESOLVE_POLICY_MISSION_COLUMNS } },
        columns: { id: true, requiresReview: true, missionId: true },
      })
    : null;
  const policy = resolvePolicy(workspace, task?.mission ?? null, task ?? null, { baseRef: pr?.base?.ref ?? worker.prBaseRef });
  if (policy.tier === 'human') return 'human_tier';

  const { landPr, resolveLandingMode } = await import('@/lib/pr-landing');
  if (resolveLandingMode(workspace.gitConfig) === 'enforce') {
    const outcome = await landPr({
      workspaceId,
      installationId,
      repoFullName: repo,
      prNumber,
      eventHeadSha: headSha,
      door: 'surface_wakeup',
      actor: { kind: 'system' },
      mode: 'enforce',
      policy,
      owner: { taskId: worker.taskId ?? null, workerId: worker.id },
      releaseConfig: workspace.releaseConfig ?? null,
      gitConfig: workspace.gitConfig ?? null,
    });
    return outcome.kind;
  }

  if (policy.tier === 'agent-review') {
    const { readPrReviewStatus } = await import('@/lib/pr-review-request');
    const { isApprovalSelfMergeable } = await import('@/lib/pr-review-status');
    const status = await readPrReviewStatus({ workspaceId, prNumber });
    if (status.state !== 'approved' || !isApprovalSelfMergeable(status, policy.agentReview?.maxConfidenceThreshold)) {
      return 'awaiting_review';
    }
  }
  const { tryAutoMergeWorkerPr } = await import('@/lib/auto-merge');
  const res = await tryAutoMergeWorkerPr({
    installationId,
    repoFullName: repo,
    prNumber,
    headSha,
    worker: { id: worker.id, taskId: worker.taskId ?? null, workspaceId },
    policy,
    surfaceOrderingConfig: workspace.gitConfig ?? null,
  });
  return res.merged ? 'merged' : `not_merged: ${res.reason ?? 'unknown'}`;
}
