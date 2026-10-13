/**
 * Reviews module: the kernel's `HandOff` port, legacy's first review for a
 * delivery the kill switch handed back before the kernel queued its first
 * round (§14). The decision (released, never reviewed, switch still off, PR
 * open, once per owner) is the package's `handOffToLegacyOn`
 * (packages/workflow-kernel/src/handlers/hand-off.ts); this files what legacy
 * would have filed, and holds the once-per-owner claim
 * (`tasks.context.workflowLegacyHandoff`).
 *
 * Files exactly what the PR-opened policy would have filed at open, had the
 * kernel not taken the PR: one reviewer task at the live head (no
 * `workflowRound`, so it is legacy's), announced and woken, plus the PR's
 * `review_queued` activity line. A delivery opened with a pre-flight finding
 * is answered the legacy way instead: the PR needs a person, and the team is
 * told. The policy is not re-run: the kernel only opens a delivery at the
 * point the policy has already asked for a review.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { notifyTeamOf } from '@/lib/notify';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { resolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS } from '@/lib/merge-policy';
import { listWorkspaceRoles } from '@/lib/pr-review-request';
import { pickReviewerRole } from '@/lib/pr-review-status';
import { conformanceManifest } from '@/lib/path-declaration';
import { reviewerTitle } from '@/lib/task-title';
import type { HandOff } from '@buildd/workflow-kernel/ports';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { claimLegacyHandoffSql, unclaimLegacyHandoffSql } from './authority';
import { workspaceRepo } from './github-facts';
import type { Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/** What legacy files for a PR's first review, given its live head and base. */
export interface LegacyFirstReviewInput {
  workspaceId: string;
  deliveryId: string;
  ownerTaskId: string;
  repoFullName: string;
  prNumber: number;
  installationId: number;
  headSha: string;
  baseRef: string | null;
  htmlUrl: string;
  /** The pre-flight finding the kernel recorded at open, if any: legacy answers it with a person, not a reviewer. */
  policyEvidence: { headSha: string; outcome: string; reason: string } | null;
}

export const legacyFirstReview = async (p: LegacyFirstReviewInput): Promise<{ outcome: string }> => {
  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, p.workspaceId)) });
  const owner = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, p.ownerTaskId)),
    columns: { id: true, title: true, description: true, backend: true, missionId: true, pathManifest: true, pathDeclaration: true, context: true },
  });
  if (!workspace || !owner) return { outcome: 'skipped:missing_context' };

  if (p.policyEvidence) {
    // Legacy's answer to a pre-flight finding: hold the PR for a person.
    await appendPrActivity({
      installationId: p.installationId, repoFullName: p.repoFullName, prNumber: p.prNumber,
      entry: { kind: 'human_review_required', note: p.policyEvidence.reason }, workspaceId: p.workspaceId,
    });
    void notifyTeamOf({ workspaceId: p.workspaceId, prNumber: p.prNumber }, 'needsAttention', {
      title: `PR #${p.prNumber} escalated`, message: p.policyEvidence.reason, url: p.htmlUrl, urlTitle: 'View PR',
    });
    return { outcome: 'human_review_required' };
  }

  const mission = owner.missionId
    ? await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, owner.missionId)), columns: RESOLVE_POLICY_MISSION_COLUMNS })
    : null;
  const policy = resolvePolicy(workspace as never, mission as never, null, { baseRef: p.baseRef });
  const roles = await listWorkspaceRoles(workspace.id, workspace.teamId);
  const picked = pickReviewerRole({ requested: null, policyRole: policy.agentReview?.reviewerRole ?? null, available: roles });
  if (!picked.role) {
    await appendPrActivity({
      installationId: p.installationId, repoFullName: p.repoFullName, prNumber: p.prNumber,
      entry: { kind: 'human_review_required', note: 'the workspace has no role that can run the agent review' }, workspaceId: p.workspaceId,
    });
    return { outcome: 'skipped:no_reviewer_role' };
  }

  const worker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.taskId, owner.id)),
    columns: { branch: true },
    orderBy: sqlOrderBy([desc(workers.createdAt)]),
  });
  const ctx: { iteration?: unknown; maxIterations?: unknown } = owner.context && typeof owner.context === 'object' ? owner.context : {};
  const { createReviewerTask } = await import('@/lib/reviewer');
  const created = await createReviewerTask({
    workspaceId: p.workspaceId,
    originalTaskId: owner.id,
    originalTask: {
      title: owner.title, description: owner.description, backend: owner.backend, missionId: owner.missionId ?? null,
      pathManifest: conformanceManifest(owner as never),
      iteration: typeof ctx.iteration === 'number' ? ctx.iteration : null,
      maxIterations: typeof ctx.maxIterations === 'number' ? ctx.maxIterations : null,
    },
    worker: { branch: worker?.branch ?? '' },
    prNumber: p.prNumber,
    prUrl: p.htmlUrl,
    headSha: p.headSha,
    reviewerRole: picked.role,
    confidenceThreshold: policy.agentReview?.maxConfidenceThreshold,
    installationId: p.installationId,
    repoFullName: p.repoFullName,
    policyConfig: workspace.gitConfig?.policyConfig ?? undefined,
    baseRef: p.baseRef,
  });
  if (!created) return { outcome: 'skipped:dispatch_refused' };
  if (created.deduplicated) return { outcome: 'reviewer_exists' };

  await announceTaskCreated({
    id: created.id, title: reviewerTitle(p.prNumber, owner.title), description: null, workspaceId: p.workspaceId,
    missionId: owner.missionId ?? null, backend: owner.backend, roleSlug: picked.role,
  } as never, workspace as never);
  await wakeTask(created.id, 'task.created');
  await appendPrActivity({
    installationId: p.installationId, repoFullName: p.repoFullName, prNumber: p.prNumber,
    entry: { kind: 'review_queued' }, workspaceId: p.workspaceId,
  });
  console.log(`[reviewer] kill-switch hand-off: legacy first review ${created.id} for PR #${p.prNumber} on ${p.repoFullName}`);
  return { outcome: 'review_queued' };
};

/** The `HandOff` port: the claim once per owner task, and legacy's first review. */
export function handOffHost(exec: Exec = dbExec): HandOff {
  return {
    async claim(d) {
      return ((await exec(claimLegacyHandoffSql(d.ownerTaskId, d.id))).rows ?? []).length > 0;
    },
    async unclaim(d) {
      await exec(unclaimLegacyHandoffSql(d.ownerTaskId));
    },
    async firstReview(p) {
      const repo = await workspaceRepo(p.d.workspaceId);
      if (!repo) throw new Error('no GitHub installation for the workspace');
      const r = await legacyFirstReview({
        workspaceId: p.d.workspaceId, deliveryId: p.d.id, ownerTaskId: p.d.ownerTaskId, repoFullName: p.d.repoFullName, prNumber: p.d.prNumber,
        installationId: repo.installationId, headSha: p.headSha, baseRef: p.baseRef,
        htmlUrl: `https://github.com/${p.d.repoFullName}/pull/${p.d.prNumber}`, policyEvidence: p.policyEvidence,
      });
      console.log(`[workflow] delivery ${p.d.id} handed to legacy after switch-off: ${r.outcome}`);
      return r;
    },
  };
}
