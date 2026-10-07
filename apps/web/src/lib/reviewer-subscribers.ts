/**
 * Reviews module, reviewer flows: who reviews a buildd PR, and when again.
 *
 * - The PR-opened slot (lib/pr-opened-policy.ts, `reviewerDispatchOnOpen`):
 *   resolve the PR's merge policy with its risk-class override, renumber a
 *   colliding migration as a mechanical fix, escalate to a human on the
 *   pre-flight check or a human tier, or dispatch the agent reviewer. Holding
 *   the PR is what keeps core's no-CI auto-merge off it.
 * - `pr.synchronized`: note the push on the PR's activity comment, then
 *   re-dispatch a reviewer after a non-approving verdict (or carry an approval
 *   forward when the diff is unchanged).
 * - `pr.ci_failed`: ask for a bounded CI-fix task (after the ledger records it).
 *
 * What stays in core: the merge policy chain itself, landing, auto-merge
 * safety and the merge tier decision.
 */
import { db } from '@buildd/core/db';
import { tasks, workspaces, missions, missionNotes } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import type { PrOpenedPolicy } from '@/lib/pr-opened-policy';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { notifyTeamOf } from '@/lib/notify';
import { retryCiFailureForPr } from '@/lib/ci-failure-retry';
import { resolvePolicy, RESOLVE_POLICY_MISSION_COLUMNS } from '@/lib/merge-policy';
import { createReviewerTask, preflightEscalationCheck } from '@/lib/reviewer';
import { applyPolicyConfigToMergePolicy } from '@/lib/workspace-policy';
import { reviewerTitle } from '@/lib/task-title';
import { inspectPullRequestMigrations } from '@/lib/migration-inspector';
import { tryDispatchMigrationCollisionRetry } from '@/lib/migration-collision-retry';
import { conformanceManifest } from '@/lib/path-declaration';
import { appendPrActivity } from '@/lib/pr-activity-comment';
import { readPrReviewStatus, listWorkspaceRoles } from '@/lib/pr-review-request';
import { pickReviewerRole } from '@/lib/pr-review-status';
import { carryForwardApprovalIfUnchanged } from '@/lib/approval-carry-forward';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import { observeHead, openKernelDelivery } from '@/lib/workflow/seam';
import { releaseKernelDeliveryForPr } from '@/lib/workflow/authority';

/** The webhook payload shape the dispatch functions read. */
type WebhookPr = { number: number; head: { sha: string }; html_url: string; base?: { ref: string }; body?: string | null };
function webhookPr(pr: { number: number; headSha: string; htmlUrl: string; baseRef: string | null; body: string | null }): WebhookPr {
  return { number: pr.number, head: { sha: pr.headSha }, html_url: pr.htmlUrl, base: pr.baseRef ? { ref: pr.baseRef } : undefined, body: pr.body };
}

/**
 * The role a webhook-dispatched review runs as, checked against the roles the
 * workspace actually has — the same `pickReviewerRole` rule the create_pr,
 * manual-review and re-review routes apply. The policy's role slug is only a
 * preference: a reviewer task routed to a role no runner advertises is never
 * claimed. Null when the workspace has no role at all.
 */
async function resolveReviewerRoleForDispatch(
  workspace: { id: string; teamId: string },
  policyRole: string | null,
  prNumber: number,
): Promise<string | null> {
  const roles = await listWorkspaceRoles(workspace.id, workspace.teamId);
  const picked = pickReviewerRole({ requested: null, policyRole, available: roles });
  if (!picked.role) {
    console.warn(`[reviewer] Not dispatching a reviewer for PR #${prNumber}: ${picked.error}`);
    return null;
  }
  if (policyRole && picked.role !== policyRole) {
    console.warn(
      `[reviewer] PR #${prNumber}: policy reviewer role '${policyRole}' does not exist in this workspace — using '${picked.role}'`,
    );
  }
  return picked.role;
}

/**
 * BT-5 / BT-10: Check merge policy for an opened PR and dispatch a reviewer task
 * if the workspace is configured for agent-review.
 *
 * Returns true if we handled the PR (reviewer task created or pre-flight escalated)
 * and the caller should skip the normal no-CI auto-merge path.
 */
async function maybeDispatchReviewer(
  installationId: number,
  repoFullName: string,
  // `body` is read for its lede only — see renderLedeGuidance in @/lib/reviewer.
  pr: WebhookPr,
  openWorker: { id: string; workspaceId: string; taskId: string; branch: string },
): Promise<boolean> {
  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, openWorker.workspaceId),
    });
    if (!workspace) return false;

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, openWorker.taskId),
      columns: { id: true, title: true, description: true, backend: true, missionId: true, pathManifest: true, pathDeclaration: true, context: true },
    });
    if (!task) return false;

    // Load mission separately to resolve merge policy
    type PolicyMission = {
      mergePolicy?: import('@buildd/shared').MergePolicy | null;
      requiresReview?: boolean;
      workingBranch?: string | null;
      integrationBranchEnabled?: boolean;
    };
    let mission: PolicyMission | null = null;
    if (task.missionId) {
      const row = await db.query.missions.findFirst({
        where: eq(missions.id, task.missionId),
        columns: RESOLVE_POLICY_MISSION_COLUMNS,
      });
      if (row) mission = row as PolicyMission;
    }
    // Take the base ref straight off the webhook payload rather than re-reading
    // workers.prBaseRef: this runs on PR open, where the DB write from the create
    // call and this event race. The payload is authoritative and race-free.
    const basePolicy = resolvePolicy(workspace, mission, null, { baseRef: pr.base?.ref ?? null });

    // Fetch PR files first (needed for policyConfig override AND pre-flight check)
    let prFiles: Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string | null;
      previous_filename?: string | null;
    }> = [];
    try {
      const raw = await githubApi(installationId, `/repos/${repoFullName}/pulls/${pr.number}/files?per_page=300`);
      if (Array.isArray(raw)) prFiles = raw;
    } catch (err) {
      console.warn(`[reviewer] Could not fetch PR files for pre-flight check on #${pr.number}:`, err);
    }

    // Classify migrations first: the schema risk class keys off the verdict
    // (EXPAND passes), not off the mere presence of a schema/migration path.
    const migrationSafety = await inspectPullRequestMigrations({
      installationId,
      repoFullName,
      prNumber: pr.number,
      headSha: pr.head.sha,
      files: prFiles,
      baseRef: pr.base?.ref ?? null,
    });

    // A migration-number collision this PR owns (see `classifyPullRequestMigrations`)
    // is a mechanical fix, not a policy decision — dispatch a renumber task
    // through the conflict-retry machinery instead of escalating to a human,
    // regardless of merge-policy tier. Only when the dispatch didn't handle it
    // (retries exhausted, feature disabled) does this fall through to the
    // normal tier/escalation logic below, unchanged.
    if (!migrationSafety.safe && migrationSafety.collision) {
      const collisionRetry = await tryDispatchMigrationCollisionRetry({
        collision: migrationSafety.collision,
        workerId: openWorker.id,
        taskId: task.id,
        prNumber: pr.number,
        headSha: pr.head.sha,
        repoFullName,
        workspaceId: openWorker.workspaceId,
        installationId,
      }).catch((err) => {
        console.error(`[reviewer] migration-collision retry dispatch failed for PR #${pr.number}:`, err);
        return { handled: false };
      });
      if (collisionRetry.handled) return true;
    }

    // Apply semantic risk-class policy override (detected policyConfig paths)
    const policyConfig = workspace.gitConfig?.policyConfig ?? null;
    const policy = applyPolicyConfigToMergePolicy(
      basePolicy,
      policyConfig,
      prFiles.map((f) => f.filename),
      migrationSafety,
    );

    if (policy.tier !== 'agent-review' && policy.tier !== 'human') return false;

    // BT-10: Pre-flight escalation guard (also handles human-tier from policyConfig)
    const preflight = preflightEscalationCheck(prFiles, policy, migrationSafety, policyConfig ?? undefined);
    const shouldEscalateToHuman = preflight.shouldEscalate || policy.tier === 'human';
    if (shouldEscalateToHuman) {
      const reason = preflight.shouldEscalate ? preflight.reason : `workspace policy requires human review`;
      console.log(`[reviewer] Pre-flight escalation for PR #${pr.number}: ${reason}`);
      // A human owns this PR now. If the kernel already opened a delivery for it
      // (create_pr's door ran first), hand it to legacy so no round is queued
      // behind the human escalation.
      await releaseKernelDeliveryForPr(openWorker.workspaceId, repoFullName, pr.number, `pre-flight escalation: ${reason}`);
      if (task.missionId) {
        await db.insert(missionNotes).values({
          missionId: task.missionId,
          taskId: task.id,
          authorType: 'system',
          type: 'reviewer_escalated',
          title: `PR #${pr.number} escalated to human (pre-flight)`,
          body: reason,
          status: 'open',
        });
        // Lazily: core-emit loads the composition root, which loads this file.
        const { emit } = await import('@/lib/core-emit');
        await emit({ type: 'pr.needs_human', missionId: task.missionId,
          title: `PR #${pr.number} requires human review`,
          prUrl: pr.html_url,
          prNumber: pr.number,
          headSha: pr.head.sha,
          reason: 'auto_merge_blocked',
          message: `${task.title} — ${reason}`,
        });
      }
      void notifyTeamOf({ workspaceId: workspace.id }, 'needsAttention', {
        title: `PR #${pr.number} escalated`,
        message: reason,
        url: pr.html_url,
        urlTitle: 'View PR',
      });
      await appendPrActivity({
        installationId,
        repoFullName,
        prNumber: pr.number,
        entry: { kind: 'human_review_required', note: reason },
        workspaceId: openWorker.workspaceId,
      });
      return true; // handled — skip auto-merge
    }

    if (policy.tier !== 'agent-review') return false;

    const reviewerRole = await resolveReviewerRoleForDispatch(workspace, policy.agentReview?.reviewerRole ?? null, pr.number);
    if (!reviewerRole) {
      // No role can run the review. Hold the PR for a human rather than fall
      // through to auto-merge: the policy asked for a review.
      await appendPrActivity({
        installationId,
        repoFullName,
        prNumber: pr.number,
        entry: { kind: 'human_review_required', note: 'the workspace has no role that can run the agent review' },
        workspaceId: openWorker.workspaceId,
      });
      return true;
    }

    // The workflow kernel takes the PR here, at the exact point the legacy path
    // would dispatch its first review (after pre-flight, with a reviewer role).
    // Its first round is queued when the owner attempt ends; nothing is
    // dispatched now.
    const kernel = await openKernelDelivery({
      workspaceId: openWorker.workspaceId,
      ownerTaskId: task.id,
      repoFullName,
      prNumber: pr.number,
      installationId,
      source: 'webhook:opened',
    }).catch((err) => {
      console.error(`[reviewer] workflow kernel could not open a delivery for PR #${pr.number}; legacy review dispatch:`, err);
      return { owned: false };
    });
    if (kernel.owned) return true; // handled — skip auto-merge

    // iteration/maxIterations are stored in task.context JSONB (not columns)
    const taskCtx = (task.context ?? {}) as Record<string, unknown>;
    const originalTask = {
      title: task.title,
      description: task.description,
      backend: task.backend,
      missionId: task.missionId ?? null,
      pathManifest: conformanceManifest(task),
      iteration: typeof taskCtx.iteration === 'number' ? taskCtx.iteration : null,
      maxIterations: typeof taskCtx.maxIterations === 'number' ? taskCtx.maxIterations : null,
    };

    // Create reviewer task
    const reviewerTask = await createReviewerTask({
      workspaceId: openWorker.workspaceId,
      originalTaskId: task.id,
      originalTask,
      worker: { branch: openWorker.branch },
      prNumber: pr.number,
      prUrl: pr.html_url,
      headSha: pr.head.sha,
      reviewerRole,
      confidenceThreshold: policy.agentReview?.maxConfidenceThreshold,
      installationId,
      repoFullName,
      policyConfig: policyConfig ?? undefined,
      migrationSafety,
      // Already fetched above for the policy override and the pre-flight
      // check — passing it through saves a second identical GitHub call.
      prFiles,
      // The webhook payload already carries the body; the reviewer reads it for
      // its lede only. Passing it saves a GET the context builder would
      // otherwise make per reviewed PR.
      prBody: pr.body ?? null,
      // Same for the base branch the reviewer diffs against.
      baseRef: pr.base?.ref ?? null,
    });

    // A deduplicated result is another producer's reviewer: it was dispatched
    // and announced by whoever created it.
    if (reviewerTask && !reviewerTask.deduplicated) {
      // The announcement needs more than just the id — pass the reviewer task details
      // we know from the params rather than re-querying the DB.
      const reviewerTaskFull = {
        id: reviewerTask.id,
        title: reviewerTitle(pr.number, task.title),
        description: null as null,
        workspaceId: openWorker.workspaceId,
        missionId: task.missionId ?? null,
        backend: originalTask.backend,
        roleSlug: reviewerRole,
      };
      await announceTaskCreated(reviewerTaskFull, workspace);
      await wakeTask(reviewerTaskFull.id, 'task.created');
      console.log(`[reviewer] Dispatched reviewer task ${reviewerTask.id} for PR #${pr.number} on ${repoFullName}`);
      // Tell the PR (not just the dashboard) a review is queued. It says
      // "Reviewing" only once a worker claims the reviewer task.
      await appendPrActivity({
        installationId,
        repoFullName,
        prNumber: pr.number,
        entry: { kind: 'review_queued' },
        workspaceId: openWorker.workspaceId,
      });
    }

    return true; // handled — skip auto-merge
  } catch (err) {
    console.error(`[reviewer] maybeDispatchReviewer failed for PR #${pr.number}:`, err);
    return false;
  }
}

/**
 * On a push to an already-open PR (`synchronize`), re-dispatch a reviewer
 * when the PR's current review verdict is a TERMINAL, NON-APPROVING one
 * (`changes_requested` / `escalated`) made against a commit the push has now
 * superseded.
 *
 * Closes the gap `maybeDispatchReviewer` leaves: that function only ever
 * fires on `action === 'opened'`, so the fix a retry task pushes after a
 * request-changes verdict was never re-reviewed — the review loop opened and
 * never closed (see review-verdict-gate.ts's module doc for the other half
 * of that bug, the gate's own stale-SHA handling).
 *
 * An `approved` verdict is deliberately NOT re-dispatched here — see
 * review-verdict-gate.ts: a push after an approval makes the gate itself
 * treat that approval as stale (blocking) rather than this function firing a
 * fresh agent review on every push after every approval, which is by far the
 * common case and usually merges before another push ever lands.
 *
 * Single-flight: skips when a review round is already `queued`/`reviewing`
 * for this PR — the same one-reviewer-per-PR-at-a-time rule the manual
 * `POST /api/prs/[prNumber]/re-review` route and the MCP `request_pr_review`
 * force path apply, so a rapid run of pushes dispatches at most one reviewer.
 * `createReviewerTask`'s own (workspace, PR, headSha) dedup guard is a
 * second, independent backstop against a redelivered webhook.
 *
 * The dispatched round inherits the SAME iteration/maxIterations the request-
 * changes retry loop already tracks on whichever task currently owns the PR
 * (the original task, or the newest retry) — so the existing cap in
 * `handleReviewerOutcomeIfNeeded` (apps/web/src/app/api/workers/[id]/route.ts,
 * default 3) keeps capping the round count and escalating on exhaustion; this
 * function does not need a cap of its own.
 */
async function maybeReDispatchReviewer(
  installationId: number,
  repoFullName: string,
  pr: WebhookPr,
  openWorker: { id: string; workspaceId: string; taskId: string; branch: string },
): Promise<void> {
  try {
    const status = await readPrReviewStatus({ workspaceId: openWorker.workspaceId, prNumber: pr.number });

    if (status.state === 'queued' || status.state === 'reviewing') {
      fireGateEvent({
        gate: GATE_SLUGS.REVIEWER_SINGLE_FLIGHT,
        surface: 'webhook synchronize',
        outcome: 'deferred',
        reason: 'a reviewer is already working this PR',
        workspaceId: openWorker.workspaceId,
        taskId: openWorker.taskId,
        workerId: openWorker.id,
        callerOrigin: 'system',
        detail: { prNumber: pr.number, reviewTaskId: status.reviewTaskId },
      });
      return;
    }

    // An approval is not re-reviewed on push. If the push left the PR diff
    // unchanged (rebase / base merge), record that the approval covers the
    // new head so the review gate does not treat it as stale; otherwise the
    // gate blocks it as stale_approval, as before.
    if (status.state === 'approved') {
      if (pr.base?.ref) {
        await carryForwardApprovalIfUnchanged({
          installationId,
          repoFullName,
          workspaceId: openWorker.workspaceId,
          prNumber: pr.number,
          baseRef: pr.base.ref,
          headSha: pr.head.sha,
          deps: { readStatus: async () => status },
        });
      }
      return;
    }

    if (status.state !== 'changes_requested' && status.state !== 'escalated') return;
    const priorVerdictKind = status.verdict;
    if (priorVerdictKind !== 'request-changes' && priorVerdictKind !== 'escalate') return;
    // No recorded SHA, or the head hasn't actually moved since the verdict
    // (a redelivered/duplicate synchronize) — nothing to re-review.
    const priorHeadSha = status.reviewHeadSha;
    if (!priorHeadSha || priorHeadSha === pr.head.sha) return;

    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, openWorker.workspaceId) });
    if (!workspace) return;

    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, openWorker.taskId),
      columns: { id: true, title: true, description: true, backend: true, missionId: true, pathManifest: true, pathDeclaration: true, context: true },
    });
    if (!task) return;

    let mission: {
      mergePolicy?: import('@buildd/shared').MergePolicy | null;
      requiresReview?: boolean;
      workingBranch?: string | null;
      integrationBranchEnabled?: boolean;
    } | null = null;
    if (task.missionId) {
      const row = await db.query.missions.findFirst({
        where: eq(missions.id, task.missionId),
        columns: RESOLVE_POLICY_MISSION_COLUMNS,
      });
      if (row) mission = row;
    }
    const policy = resolvePolicy(workspace, mission, null, { baseRef: pr.base?.ref ?? null });
    // The PR was already dispatched to a reviewer once under this policy — a
    // tier change since then (workspace policy edited mid-review) means the
    // workspace no longer wants an agent re-reviewing it.
    if (policy.tier !== 'agent-review') return;

    const reviewerRole = await resolveReviewerRoleForDispatch(workspace, policy.agentReview?.reviewerRole ?? null, pr.number);
    if (!reviewerRole) return;

    const taskCtx = (task.context ?? {}) as Record<string, unknown>;
    const originalTask = {
      title: task.title,
      description: task.description,
      backend: task.backend,
      missionId: task.missionId ?? null,
      pathManifest: conformanceManifest(task),
      iteration: typeof taskCtx.iteration === 'number' ? taskCtx.iteration : null,
      maxIterations: typeof taskCtx.maxIterations === 'number' ? taskCtx.maxIterations : null,
    };

    const reviewerTask = await createReviewerTask({
      workspaceId: openWorker.workspaceId,
      originalTaskId: task.id,
      originalTask,
      worker: { branch: openWorker.branch },
      prNumber: pr.number,
      prUrl: pr.html_url,
      headSha: pr.head.sha,
      reviewerRole,
      confidenceThreshold: policy.agentReview?.maxConfidenceThreshold,
      installationId,
      repoFullName,
      policyConfig: workspace.gitConfig?.policyConfig ?? undefined,
      baseRef: pr.base?.ref ?? null,
      priorVerdict: {
        headSha: priorHeadSha,
        verdict: priorVerdictKind,
        confidence: status.confidence ?? 0,
        summary: status.summary ?? '',
        feedback: status.feedback,
        escalationReason: status.escalationReason,
      },
    });

    if (!reviewerTask || reviewerTask.deduplicated) return;

    const reviewerTaskFull = {
      id: reviewerTask.id,
      title: reviewerTitle(pr.number, task.title),
      description: null as null,
      workspaceId: openWorker.workspaceId,
      missionId: task.missionId ?? null,
      backend: originalTask.backend,
      roleSlug: reviewerRole,
    };
    await announceTaskCreated(reviewerTaskFull, workspace);
    await wakeTask(reviewerTaskFull.id, 'task.created');
    console.log(`[reviewer] Re-dispatched reviewer task ${reviewerTask.id} for PR #${pr.number} on ${repoFullName} (was ${status.state} at ${priorHeadSha.slice(0, 7)})`);
    await appendPrActivity({
      installationId,
      repoFullName,
      prNumber: pr.number,
      // The renderer words this "Re-review queued · after fix N" from the log;
      // the claim turns it into "Re-reviewing".
      entry: { kind: 'review_queued' },
      workspaceId: openWorker.workspaceId,
    });
  } catch (err) {
    console.error(`[reviewer] maybeReDispatchReviewer failed for PR #${pr.number}:`, err);
  }
}


/** The PR-opened slot's policy: `held` when the PR was taken (see the module doc). */
export const reviewerDispatchOnOpen: PrOpenedPolicy = async (input) => ({
  held: await maybeDispatchReviewer(input.installationId, input.repoFullName, webhookPr(input.pr), input.worker),
});

export const reviewerSubscribers: readonly AnySubscriber[] = [
  // Follow-up push on a PR buildd is already working (CI fix or review fix).
  // onlyIfPresent: no sticky comment yet means we haven't claimed this PR,
  // so a bare "fixes pushed" note would be noise. Idempotent on redelivery.
  subscriber('reviews', 'pr.synchronized', 'pr-activity-changes-pushed', async e => {
    await appendPrActivity({
      installationId: e.installationId,
      repoFullName: e.repoFullName,
      prNumber: e.pr.number,
      entry: {
        kind: 'changes_pushed',
        sha: e.pr.headSha.slice(0, 7),
        url: `${e.pr.htmlUrl}/commits/${e.pr.headSha}`,
      },
      onlyIfPresent: true,
      workspaceId: e.worker.workspaceId,
    });
  }),
  // A push to an already-open PR: if the PR carries an existing terminal,
  // non-approving verdict (changes_requested/escalated), re-dispatch a
  // reviewer against the new head. Without this the review loop never
  // closes; see maybeReDispatchReviewer's doc comment.
  subscriber('reviews', 'pr.synchronized', 'reviewer-redispatch-on-push', async e => {
    if (e.pr.draft || !e.worker.taskId) return;
    // A kernel-owned PR: the push is a HeadObserved fact (T3). The kernel
    // decides re-review, carry-forward and fix supersession; the legacy
    // re-dispatch below must not run beside it.
    const kernelHandled = await observeHead({
      workspaceId: e.worker.workspaceId,
      repoFullName: e.repoFullName,
      prNumber: e.pr.number,
      installationId: e.installationId,
      hintedHeadSha: e.pr.headSha,
      source: 'webhook:synchronize',
      carryForward: async (live) => {
        const baseRef = live.baseRef ?? e.pr.baseRef;
        if (!baseRef) return null;
        const r = await carryForwardApprovalIfUnchanged({
          installationId: e.installationId, repoFullName: e.repoFullName, workspaceId: e.worker.workspaceId,
          prNumber: e.pr.number, baseRef, headSha: live.headSha,
        });
        return r.carried ? 'content_equivalent' : null;
      },
    }).catch((err) => {
      // Ownership could not even be read: behave as before the kernel.
      console.error(`[reviewer] workflow kernel ownership check failed for PR #${e.pr.number}:`, err);
      return false;
    });
    if (kernelHandled) return;
    await maybeReDispatchReviewer(e.installationId, e.repoFullName, webhookPr(e.pr), { ...e.worker, taskId: e.worker.taskId });
  }),
  // CI went red: hand the PR to retryCiFailureForPr, which files a bounded
  // CI-fix task or records why not. The red-PR sweep (lib/ci-red-sweep.ts)
  // calls the same function for a PR this event could not act on.
  subscriber('reviews', 'pr.ci_failed', 'ci-failure-retry', async e => {
    await retryCiFailureForPr({
      repoFullName: e.repoFullName,
      prNumber: e.prNumber,
      headSha: e.headSha,
      installationId: e.installationId,
      surface: 'webhook:check_suite',
    });
  }),
];
