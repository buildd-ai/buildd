/**
 * Conflict-retry — auto-dispatch when a PR has merge conflicts.
 *
 * When a merge attempt fails because the PR has conflicts (dirty), instead of
 * surfacing a useless Retry button, buildd dispatches a same-branch needs-work
 * task so the original agent can resolve the conflicts in context.
 *
 * Doctrine (from PR #1123 / task 6cc036c3):
 *   - Do NOT create a separate integration task.
 *   - Flip the originating task back to needs-work on the same branch.
 *   - One retry task per (workspaceId, prNumber, headSha) — deduped.
 *
 * Guard:
 *   - Honors maxConflictIterations (default 3). On exhaustion, does NOT dispatch
 *     and returns { exhausted: true } — callers must escalate to human.
 *   - Controlled by workspace gitConfig.autoResolveMergeConflicts (default ON).
 */

import { db } from '@buildd/core/db';
import { tasks, workers, workspaces, missionNotes } from '@buildd/core/db/schema';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { runSupersessionPrecheck, DEFAULT_SUPERSESSION_DRIFT_RATIO } from '@/lib/supersession-check';
import { notify } from '@/lib/pushover';

export const DEFAULT_MAX_CONFLICT_ITERATIONS = 3;

// ── Classification ────────────────────────────────────────────────────────────

export type MergeFailureClass = 'conflict' | 'retryable' | 'blocked';

/**
 * Classify a GitHub merge rejection by its error message / context.
 *
 * - 'conflict': PR has merge conflicts — NOT retryable as-is, needs rebase/merge.
 * - 'retryable': transient failure (network, unknown) — safe to retry the merge.
 * - 'blocked': branch protection, failing CI, review required — structurally
 *              blocked; retrying the same merge won't help.
 */
export function classifyMergeFailure(message: string): MergeFailureClass {
  const lower = message.toLowerCase();
  if (
    lower.includes('merge conflict') ||
    lower.includes('has merge conflicts') ||
    lower.includes('mergeable_state: dirty') ||
    lower.includes('needs rebase') ||
    lower.includes('unresolvable conflicts')
  ) {
    return 'conflict';
  }
  if (
    lower.includes('method not allowed') ||
    lower.includes('405') ||
    lower.includes('branch protection') ||
    lower.includes('required status') ||
    lower.includes('review required') ||
    lower.includes('cannot be merged')
  ) {
    return 'blocked';
  }
  return 'retryable';
}

/**
 * Returns true when workspace config allows auto-dispatch for merge conflicts.
 * Absent = true (default ON).
 */
export function isAutoResolveMergeConflictsEnabled(
  gitConfig: WorkspaceGitConfig | null | undefined,
): boolean {
  return gitConfig?.autoResolveMergeConflicts !== false;
}

// ── Retry task builder ────────────────────────────────────────────────────────

export interface ConflictRetryInput {
  originalTask: {
    id: string;
    title: string;
    description: string | null;
    workspaceId: string;
    context: Record<string, unknown> | null;
    missionId?: string | null;
  };
  worker: {
    id: string;
    branch: string;
    prNumber: number;
  };
  /** Current head SHA of the PR — used for dedup key. */
  headSha: string;
  /** Repo "owner/name" string — for GitHub URLs in the description. */
  repoFullName: string;
  /** Override max iterations (default 3). */
  maxConflictIterations?: number;
}

export interface ConflictRetryTask {
  title: string;
  description: string;
  workspaceId: string;
  parentTaskId: string;
  missionId: string | null;
  creationSource: 'conflict';
  conflictRetryPrNumber: number;
  conflictRetryHeadSha: string;
  context: Record<string, unknown>;
}

/**
 * Build a conflict-resolution retry task descriptor (pure, no DB).
 *
 * Returns null when retries are exhausted or disabled (maxConflictIterations === 0).
 */
export function buildConflictRetryTask(params: ConflictRetryInput): ConflictRetryTask | null {
  const { originalTask, worker, headSha, repoFullName, maxConflictIterations } = params;
  const ctx = originalTask.context || {};

  const currentIteration = typeof ctx.conflictIteration === 'number' ? ctx.conflictIteration : 0;
  const maxIterations = maxConflictIterations ?? (
    typeof ctx.maxConflictIterations === 'number' ? ctx.maxConflictIterations : DEFAULT_MAX_CONFLICT_ITERATIONS
  );

  if (maxIterations <= 0 || currentIteration >= maxIterations) {
    return null;
  }

  const nextIteration = currentIteration + 1;

  const cleanTitle = originalTask.title
    .replace(/^\[Conflict Retry #?\d*\]\s*/i, '')
    .replace(/^\[CI Retry #?\d*\]\s*/i, '');

  return {
    title: `[Conflict Retry #${nextIteration}] ${cleanTitle}`,
    description: buildConflictDescription(originalTask, worker, repoFullName, nextIteration, maxIterations),
    workspaceId: originalTask.workspaceId,
    parentTaskId: originalTask.id,
    missionId: originalTask.missionId ?? null,
    creationSource: 'conflict',
    conflictRetryPrNumber: worker.prNumber,
    conflictRetryHeadSha: headSha,
    context: {
      // Branch continuity — agent starts from the conflicted branch
      baseBranch: worker.branch,
      resumeBranch: worker.branch,
      // Structured failure context
      failureContext: {
        summary: `PR #${worker.prNumber} has merge conflicts with the base branch. Merge the base branch in and resolve on the merits.`,
        errorType: 'merge_conflict' as const,
        prNumber: worker.prNumber,
        headSha,
      },
      conflictIteration: nextIteration,
      maxConflictIterations: maxIterations,
      prNumber: worker.prNumber,
      ...(ctx.skillSlugs ? { skillSlugs: ctx.skillSlugs } : {}),
      ...(ctx.verificationCommand ? { verificationCommand: ctx.verificationCommand } : {}),
    },
  };
}

function buildConflictDescription(
  task: ConflictRetryInput['originalTask'],
  worker: ConflictRetryInput['worker'],
  repoFullName: string,
  iteration: number,
  maxIterations: number,
): string {
  const prUrl = `https://github.com/${repoFullName}/pull/${worker.prNumber}`;

  return `PR #${worker.prNumber} for "${task.title}" has merge conflicts with the base branch.

**Attempt ${iteration} of ${maxIterations}.**

## Instructions

1. You are on branch \`${worker.branch}\`. Your worktree is based on the previous attempt's work.
2. Fetch and merge the base branch to incorporate upstream changes:
   \`\`\`bash
   git fetch origin
   git merge origin/dev   # or origin/main — use the PR's actual base branch
   \`\`\`
3. Resolve all conflicts on the merits — keep both intents, do NOT use blanket \`--ours\` or \`--theirs\`.
4. Run the test suite and verify correctness before pushing.
5. Push your resolved branch — the existing PR (#${worker.prNumber}) will auto-update.

PR: ${prUrl}

${task.description ? `## Original Task Description\n\n${task.description}` : ''}`;
}

// ── DB dispatch ───────────────────────────────────────────────────────────────

export interface DispatchConflictRetryParams {
  /** ID of the worker whose PR has conflicts. */
  workerId: string;
  /** ID of the original task (from worker.taskId). */
  taskId: string;
  /** PR number (from worker.prNumber). */
  prNumber: number;
  /** Current head SHA of the PR — from GitHub API or worker.lastCommitSha. */
  headSha: string;
  /** Repo full name "owner/name" for description URLs. */
  repoFullName: string;
  /** Workspace ID. */
  workspaceId: string;
}

export interface DispatchConflictRetryResult {
  dispatched: boolean;
  taskId?: string;
  /** True when iteration cap was reached — caller should escalate to human. */
  exhausted?: boolean;
  /** True when the feature is disabled on this workspace. */
  disabled?: boolean;
  /** True when the supersession precheck determined the change is already upstream. */
  superseded?: boolean;
  /** The PR that appears to have already landed the change, if identifiable. */
  successorPrNumber?: number | null;
}

/**
 * Fetch task + workspace, then build, insert, and dispatch a conflict-resolution retry.
 *
 * Deduped by (workspaceId, prNumber, headSha) via the conflictRetryEventIdx
 * unique index — safe to call concurrently; second caller gets dispatched=false.
 */
export async function dispatchConflictRetry(
  params: DispatchConflictRetryParams,
): Promise<DispatchConflictRetryResult> {
  const { workerId, taskId, prNumber, headSha, repoFullName, workspaceId } = params;

  // Fetch workspace (needed for autoResolveMergeConflicts flag + dispatchNewTask)
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    with: { githubInstallation: true },
  });
  if (!workspace) {
    console.warn(`[conflict-retry] workspace ${workspaceId} not found — skipping dispatch`);
    return { dispatched: false };
  }

  if (!isAutoResolveMergeConflictsEnabled(workspace.gitConfig)) {
    return { dispatched: false, disabled: true };
  }

  // Fetch the original task
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, title: true, description: true, workspaceId: true, context: true, missionId: true, parentTaskId: true },
  });
  if (!task) {
    console.warn(`[conflict-retry] task ${taskId} not found — skipping dispatch`);
    return { dispatched: false };
  }

  // Fetch the worker for branch info and recorded diff stats
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    columns: { id: true, branch: true, prNumber: true, filesChanged: true, linesAdded: true, linesRemoved: true },
  });
  if (!worker || !worker.branch) {
    console.warn(`[conflict-retry] worker ${workerId} not found or has no branch — skipping dispatch`);
    return { dispatched: false };
  }

  // ── Supersession precheck ─────────────────────────────────────────────────
  // Run before building the retry task. If the PR's changes are already upstream,
  // halt the chain and escalate rather than burning an attempt.
  const installationId = workspace.githubInstallation?.installationId ?? null;
  if (installationId) {
    const precheck = await runSupersessionPrecheck({
      installationId,
      repoFullName,
      prNumber,
      recordedStats: {
        filesChanged: worker.filesChanged ?? 0,
        linesAdded: worker.linesAdded ?? 0,
        linesRemoved: worker.linesRemoved ?? 0,
      },
      driftRatioThreshold:
        (workspace.gitConfig as WorkspaceGitConfig | null)?.supersessionDriftRatioThreshold
        ?? DEFAULT_SUPERSESSION_DRIFT_RATIO,
      workspaceId,
      taskId,
    }).catch(err => {
      console.warn(`[conflict-retry] supersession precheck failed for PR #${prNumber} (non-fatal):`, err);
      return null;
    });

    if (precheck?.superseded) {
      console.log(
        `[conflict-retry] supersession detected for PR #${prNumber} (signals: ${precheck.signals.join(', ')},` +
        ` driftLines: ${precheck.driftRatioLines?.toFixed(1)}x,` +
        ` successor: ${precheck.successorPrNumber ?? 'unknown'}) — halting retry chain`,
      );
      await escalateSupersession(
        taskId,
        repoFullName,
        prNumber,
        precheck.successorPrNumber ?? null,
      ).catch(err =>
        console.error(`[conflict-retry] escalateSupersession failed for PR #${prNumber}:`, err),
      );
      return {
        dispatched: false,
        superseded: true,
        successorPrNumber: precheck.successorPrNumber,
      };
    }
  }

  const retryTask = buildConflictRetryTask({
    originalTask: {
      id: task.id,
      title: task.title,
      description: task.description,
      workspaceId: task.workspaceId,
      context: (task.context as Record<string, unknown>) || null,
      missionId: task.missionId,
    },
    worker: { id: worker.id, branch: worker.branch, prNumber },
    headSha,
    repoFullName,
  });

  if (!retryTask) {
    console.log(`[conflict-retry] iteration cap reached for PR #${prNumber} — escalate to human`);
    return { dispatched: false, exhausted: true };
  }

  const [newTask] = await db
    .insert(tasks)
    .values({
      workspaceId: retryTask.workspaceId,
      title: retryTask.title,
      description: retryTask.description,
      parentTaskId: retryTask.parentTaskId,
      missionId: retryTask.missionId,
      context: retryTask.context,
      creationSource: retryTask.creationSource,
      taskClass: 'attempt',
      conflictRetryPrNumber: retryTask.conflictRetryPrNumber,
      conflictRetryHeadSha: retryTask.conflictRetryHeadSha,
      status: 'pending',
      priority: 8,
    })
    .onConflictDoNothing()
    .returning();

  if (!newTask) {
    // Hit the unique index — duplicate, already dispatched
    return { dispatched: false };
  }

  await dispatchNewTask(newTask, workspace);
  console.log(
    `[conflict-retry] dispatched task ${newTask.id} for PR #${prNumber}@${headSha.slice(0, 7)} (iteration ${retryTask.context.conflictIteration}/${retryTask.context.maxConflictIterations})`,
  );

  return { dispatched: true, taskId: newTask.id };
}

// ── Supersession escalation ───────────────────────────────────────────────────

/**
 * Emit escalation when the supersession precheck determines this PR's changes
 * have already landed in base via a different route.
 *
 * Idempotent: CAS on tasks.context.supersessionEscalatedPrNumber — fires at
 * most once per (taskId, prNumber).
 *
 * Exported from conflict-retry (not auto-merge) to avoid a circular dependency:
 * auto-merge → conflict-retry → auto-merge.
 */
export async function escalateSupersession(
  taskId: string,
  repoFullName: string,
  prNumber: number,
  successorPrNumber: number | null,
): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, missionId: true, title: true, context: true },
  });
  if (!task) return;

  // Atomic dedup: only one escalation per (taskId, prNumber)
  const [claimed] = await db
    .update(tasks)
    .set({
      context: sql`COALESCE(context, '{}'::jsonb) || jsonb_build_object('supersessionEscalatedPrNumber', ${prNumber}::int)`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        or(
          sql`context IS NULL`,
          sql`context->>'supersessionEscalatedPrNumber' IS NULL`,
        ),
      ),
    )
    .returning({ id: tasks.id });

  if (!claimed) {
    console.log(`[supersession] escalation already fired for task ${taskId} PR #${prNumber}`);
    return;
  }

  const prUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;
  const taskUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev'}/app/tasks/${taskId}`;
  const successorClause = successorPrNumber
    ? ` PR #${prNumber}'s fix appears to have landed via PR #${successorPrNumber}.`
    : '';

  if (task.missionId) {
    const successorNote = successorPrNumber
      ? `\n\nPR #${successorPrNumber} appears to have already landed the same change.`
      : '';
    await db.insert(missionNotes).values({
      missionId: task.missionId,
      taskId: task.id,
      authorType: 'system',
      type: 'reviewer_escalated',
      title: `PR #${prNumber} — SUPERSEDED · close?`,
      body: `The conflict-retry precheck detected that this PR's changes are already present in the base branch.${successorNote}\n\nChoose one:\n- **Close PR** — the change landed elsewhere; this PR is no longer needed\n- **Reopen investigation** — re-read the diff and re-dispatch if the change is genuinely different\n\nPR: ${prUrl}`,
      status: 'open',
    });
  }

  notify({
    app: 'tasks',
    title: `PR #${prNumber}: SUPERSEDED · close?`,
    message: `${task.title}\nChanges appear to already be in base.${successorClause}\nClose or re-investigate.`,
    url: taskUrl,
    urlTitle: 'View task',
    priority: 0,
  });

  console.log(`[supersession] escalated PR #${prNumber} for task ${taskId}${successorPrNumber ? ` (successor: #${successorPrNumber})` : ''}`);
}
