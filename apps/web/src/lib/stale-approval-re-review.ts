/**
 * Re-review a stale approval — the unattended follow-up to the review gate's
 * `stale_approval` block.
 *
 * A push to an approved PR (a base refresh, a fix-up commit) moves the head.
 * The merge doors first try to carry the approval to the new head
 * (approval-carry-forward.ts); that succeeds only when the PR diff is
 * unchanged. When it fails the gate blocks as `stale_approval`, and before this
 * module nothing followed up: the gate's advice ("request a re-review") needed a
 * person. This sends a reviewer instead, through the same machinery the
 * dashboard re-review route and `request_pr_review` use:
 *
 *   - `resolveReReviewPlan` decides delta (against the prior approval's commit)
 *     vs full, and reports a reviewer already working the PR;
 *   - `createReviewerTask` refuses a second live reviewer for the same PR head
 *     (its pre-dispatch dedupe, backed by a unique index), so concurrent merge
 *     attempts on one head file one review.
 *
 * Together that is single-flight per PR + head SHA. Never throws: a failure to
 * send a reviewer must not be what fails the merge attempt that asked.
 */

import type { MergePolicy } from '@buildd/shared';
import type { ReReviewPlan } from '@/lib/pr-re-review';
import type { CreateReviewerTaskParams } from '@/lib/reviewer';

export interface StaleApprovalReReviewInput {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** The live head the approval no longer covers. */
  headSha: string;
  baseRef: string | null;
  /** The PR's owning task and worker: the reviewer reviews their work. */
  taskId: string | null;
  workerId: string | null;
  policy: Pick<MergePolicy, 'agentReview'>;
  /**
   * Set when the stale thing is a blocking verdict rather than an approval
   * (the landing function's revalidation): why it no longer holds. Labels the
   * PR activity entry; the dispatch is otherwise identical.
   */
  staleReason?: string;
}

export type StaleApprovalReReviewResult =
  | { outcome: 'dispatched'; reviewTaskId: string; plan: 'delta' | 'full' }
  /** A reviewer already owns this PR (or this head): nothing new was filed. */
  | { outcome: 'already_reviewing'; reviewTaskId: string }
  | { outcome: 'skipped'; reason: string };

interface ReReviewContext {
  workspace: { id: string; teamId: string; gitConfig?: { policyConfig?: unknown } | null } & Record<string, unknown>;
  task: {
    id: string;
    title: string;
    description: string | null;
    backend: 'claude' | 'codex' | null;
    missionId: string | null;
    pathManifest: string[] | null;
    context: unknown;
  };
  worker: { branch: string; prUrl: string | null };
}

export interface StaleApprovalReReviewDeps {
  resolvePlan: (p: { workspaceId: string; prNumber: number; currentHeadSha: string }) => Promise<ReReviewPlan>;
  loadContext: (p: { workspaceId: string; taskId: string; workerId: string }) => Promise<ReReviewContext | null>;
  listRoles: (workspaceId: string, teamId: string) => Promise<Array<{ slug: string; isRole: boolean | null }>>;
  createReviewerTask: (p: CreateReviewerTaskParams) => Promise<{ id: string; deduplicated?: true } | null>;
  announceTaskCreated: (task: Record<string, unknown>, workspace: Record<string, unknown>) => Promise<void>;
  wakeTask: (taskId: string, cause: 'task.created') => Promise<void>;
  appendPrActivity: (p: Record<string, unknown>) => Promise<unknown>;
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function dispatchStaleApprovalReReview(
  input: StaleApprovalReReviewInput,
  deps?: StaleApprovalReReviewDeps,
): Promise<StaleApprovalReReviewResult> {
  try {
    return await run(input, deps ?? (await defaultDeps()));
  } catch (err) {
    console.warn(`[stale-approval] re-review dispatch failed for PR #${input.prNumber}:`, errMessage(err));
    return { outcome: 'skipped', reason: `re-review dispatch failed: ${errMessage(err)}` };
  }
}

async function run(input: StaleApprovalReReviewInput, deps: StaleApprovalReReviewDeps): Promise<StaleApprovalReReviewResult> {
  const { workspaceId, prNumber, headSha, taskId, workerId } = input;
  if (!taskId || !workerId) return { outcome: 'skipped', reason: 'no task owns this PR to re-review' };

  const plan = await deps.resolvePlan({ workspaceId, prNumber, currentHeadSha: headSha });
  if (plan.kind === 'in_flight') return { outcome: 'already_reviewing', reviewTaskId: plan.reviewTaskId };

  const ctx = await deps.loadContext({ workspaceId, taskId, workerId });
  if (!ctx) return { outcome: 'skipped', reason: 'could not load the PR\'s task, worker or workspace' };
  if (!ctx.worker.prUrl) return { outcome: 'skipped', reason: 'the PR has no recorded URL' };

  const { pickReviewerRole } = await import('@/lib/pr-review-status');
  const picked = pickReviewerRole({
    requested: null,
    policyRole: input.policy.agentReview?.reviewerRole ?? null,
    available: await deps.listRoles(workspaceId, ctx.workspace.teamId),
  });
  if (!picked.role) return { outcome: 'skipped', reason: picked.error ?? 'no reviewer role in this workspace' };

  const taskCtx = (ctx.task.context ?? {}) as Record<string, unknown>;
  const backend = ctx.task.backend ?? 'claude';
  const created = await deps.createReviewerTask({
    workspaceId,
    originalTaskId: ctx.task.id,
    originalTask: {
      title: ctx.task.title,
      description: ctx.task.description,
      backend,
      missionId: ctx.task.missionId,
      pathManifest: ctx.task.pathManifest,
      iteration: typeof taskCtx.iteration === 'number' ? taskCtx.iteration : null,
      maxIterations: typeof taskCtx.maxIterations === 'number' ? taskCtx.maxIterations : null,
    },
    worker: { branch: ctx.worker.branch },
    prNumber,
    prUrl: ctx.worker.prUrl,
    headSha,
    reviewerRole: picked.role,
    confidenceThreshold: input.policy.agentReview?.maxConfidenceThreshold,
    installationId: input.installationId,
    repoFullName: input.repoFullName,
    policyConfig: ctx.workspace.gitConfig?.policyConfig as CreateReviewerTaskParams['policyConfig'],
    baseRef: input.baseRef,
    ...(plan.kind === 'delta' ? { priorVerdict: plan.priorVerdict } : {}),
  });
  if (!created?.id) return { outcome: 'skipped', reason: 'could not create the reviewer task' };
  if (created.deduplicated) return { outcome: 'already_reviewing', reviewTaskId: created.id };

  const { reviewerTitle } = await import('@/lib/task-title');
  await deps.announceTaskCreated(
    {
      id: created.id,
      title: reviewerTitle(prNumber, ctx.task.title),
      description: null,
      workspaceId,
      missionId: ctx.task.missionId,
      backend,
      roleSlug: picked.role,
    },
    ctx.workspace,
  );
  await deps.wakeTask(created.id, 'task.created');
  await deps
    .appendPrActivity({
      installationId: input.installationId,
      repoFullName: input.repoFullName,
      prNumber,
      entry: {
        kind: 'reviewing',
        detail: input.staleReason
          ? `verdict went stale · ${input.staleReason}`
          : plan.kind === 'delta'
            ? `approval went stale · since \`${plan.priorVerdict.headSha.slice(0, 7)}\``
            : 'approval went stale',
      },
      workspaceId,
    })
    .catch(() => {});
  console.log(`[stale-approval] PR #${prNumber}: dispatched ${plan.kind} re-review ${created.id} at ${headSha.slice(0, 7)}`);
  return { outcome: 'dispatched', reviewTaskId: created.id, plan: plan.kind };
}

/** DB-bound defaults, imported lazily so this module loads nothing heavy until it runs. */
async function defaultDeps(): Promise<StaleApprovalReReviewDeps> {
  const [{ resolveReReviewPlan }, { listWorkspaceRoles }, { createReviewerTask }, { announceTaskCreated, wakeTask }, { appendPrActivity }] =
    await Promise.all([
      import('@/lib/pr-re-review'),
      import('@/lib/pr-review-request'),
      import('@/lib/reviewer'),
      import('@/lib/dispatch-authority'),
      import('@/lib/pr-activity-comment'),
    ]);
  return {
    resolvePlan: resolveReReviewPlan,
    loadContext,
    listRoles: listWorkspaceRoles,
    createReviewerTask,
    announceTaskCreated: (task, workspace) => announceTaskCreated(task as never, workspace as never),
    wakeTask,
    appendPrActivity: (p) => appendPrActivity(p as never),
  };
}

async function loadContext(p: { workspaceId: string; taskId: string; workerId: string }): Promise<ReReviewContext | null> {
  const [{ db }, { tasks, workers, workspaces }, { eq }, { conformanceManifest }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
    import('@/lib/path-declaration'),
  ]);
  const [workspace, task, worker] = await Promise.all([
    db.query.workspaces.findFirst({ where: eq(workspaces.id, p.workspaceId) }),
    db.query.tasks.findFirst({
      where: eq(tasks.id, p.taskId),
      columns: { id: true, title: true, description: true, backend: true, missionId: true, pathManifest: true, pathDeclaration: true, context: true },
    }),
    db.query.workers.findFirst({ where: eq(workers.id, p.workerId), columns: { branch: true, prUrl: true } }),
  ]);
  if (!workspace || !task || !worker) return null;
  return {
    workspace: workspace as unknown as ReReviewContext['workspace'],
    task: {
      id: task.id,
      title: task.title,
      description: task.description ?? null,
      backend: (task.backend as 'claude' | 'codex' | null) ?? null,
      missionId: task.missionId ?? null,
      pathManifest: conformanceManifest(task),
      context: task.context,
    },
    worker: { branch: worker.branch, prUrl: worker.prUrl ?? null },
  };
}
