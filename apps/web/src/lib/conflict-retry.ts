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
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { eq, inArray, isNotNull, and } from 'drizzle-orm';
import { pathsOverlap } from '@buildd/core/path-overlap';
import { dispatchNewTask } from '@/lib/task-dispatch';

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
    pathManifest?: string[] | null;
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
  /** pathManifest inherited from the original task, or ['**'] when the task belongs to a mission. */
  pathManifest: string[] | null;
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

  // Inherit pathManifest from original task; fall back to ['**'] for mission tasks
  // so the path-overlap serialization gate fires correctly for sibling tasks.
  const pathManifest: string[] | null =
    originalTask.pathManifest && originalTask.pathManifest.length > 0
      ? originalTask.pathManifest
      : originalTask.missionId
        ? ['**']
        : null;

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
    pathManifest,
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
    columns: { id: true, title: true, description: true, workspaceId: true, context: true, missionId: true, parentTaskId: true, pathManifest: true },
  });
  if (!task) {
    console.warn(`[conflict-retry] task ${taskId} not found — skipping dispatch`);
    return { dispatched: false };
  }

  // Fetch the worker for branch info
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    columns: { id: true, branch: true, prNumber: true },
  });
  if (!worker || !worker.branch) {
    console.warn(`[conflict-retry] worker ${workerId} not found or has no branch — skipping dispatch`);
    return { dispatched: false };
  }

  const retryTask = buildConflictRetryTask({
    originalTask: {
      id: task.id,
      title: task.title,
      description: task.description,
      workspaceId: task.workspaceId,
      context: (task.context as Record<string, unknown>) || null,
      missionId: task.missionId,
      pathManifest: task.pathManifest as string[] | null,
    },
    worker: { id: worker.id, branch: worker.branch, prNumber },
    headSha,
    repoFullName,
  });

  if (!retryTask) {
    console.log(`[conflict-retry] iteration cap reached for PR #${prNumber} — escalate to human`);
    return { dispatched: false, exhausted: true };
  }

  // Auto-compute dependsOn for path-overlap serialization — same logic as POST /api/tasks.
  const resolvedDependsOn: string[] = [];
  if (retryTask.pathManifest && retryTask.pathManifest.length > 0) {
    const inFlightTasks = await db.query.tasks.findMany({
      where: and(
        eq(tasks.workspaceId, workspaceId),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
        isNotNull(tasks.pathManifest),
      ),
      columns: { id: true, pathManifest: true },
    });
    for (const t of inFlightTasks) {
      if (!t.pathManifest?.length) continue;
      if (pathsOverlap(retryTask.pathManifest, t.pathManifest as string[])) {
        resolvedDependsOn.push(t.id);
      }
    }
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
      subjectKind: 'pull_request',
      subjectPrNumber: prNumber,
      subjectHeadSha: headSha,
      subjectBranch: worker.branch,
      subjectDedupeScope: 'active',
      pathManifest: retryTask.pathManifest,
      ...(resolvedDependsOn.length > 0 ? { dependsOn: resolvedDependsOn } : {}),
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
