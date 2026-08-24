/**
 * Dead-zone sweep: detect open worker PRs where the originating task has
 * completed/failed but the PR has become dirty (merge conflicts) and no active
 * worker is handling resolution.
 *
 * Called from /api/cron/pr-reconcile alongside reconcileStalePrWorkers — this
 * is the ONLY GitHub poller for this case (no second poller added).
 *
 * Flow per PR:
 *   1. Worker has open PR + originating task is terminal.
 *   2. GitHub says mergeable_state = 'dirty'.
 *   3a. No active conflict retry → spark one (reuse conflict-retry machinery).
 *   3b. Retries exhausted → stamp prLifecycleStatus='conflict'; escalation inbox
 *       surfaces it as a BLOCKED card.
 *
 * Dedup:
 *   - Active-retry check prevents filing while one is in flight.
 *   - The (workspaceId, conflictRetryPrNumber, conflictRetryHeadSha) unique index
 *     in the tasks table prevents duplicate tasks for the same PR head SHA.
 */

import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, isNotNull, isNull, sql, desc } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import {
  buildConflictRetryTask,
  DEFAULT_MAX_CONFLICT_ITERATIONS,
  isAutoResolveMergeConflictsEnabled,
} from '@/lib/conflict-retry';
import { dispatchNewTask } from '@/lib/task-dispatch';

// ── Pure predicates ───────────────────────────────────────────────────────────

export type DeadZoneAction = 'spark' | 'exhaust' | 'skip';

/** Terminal task statuses — no worker will resume them. */
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/**
 * Pure: should we spark/exhaust/skip based on retry counts?
 *
 * - skip: an active conflict retry is in flight — let it run.
 * - exhaust: all iterations consumed — escalate to human (BLOCKED card).
 * - spark: fire a new conflict retry task.
 */
export function classifyDeadZoneAction(
  activeRetryCount: number,
  completedRetryCount: number,
  maxIterations: number = DEFAULT_MAX_CONFLICT_ITERATIONS,
): DeadZoneAction {
  if (activeRetryCount > 0) return 'skip';
  if (completedRetryCount >= maxIterations) return 'exhaust';
  return 'spark';
}

/**
 * Pure: is this worker+task pair a dead-zone candidate for the sweep?
 *
 * A candidate has an open (unmerged, non-closed) PR and a terminal
 * originating task (no worker will resume it).
 */
export function isDeadZoneCandidate(
  taskStatus: string,
  prUrl: string | null,
  mergedAt: Date | null,
  prLifecycleStatus: string | null,
): boolean {
  if (!prUrl || mergedAt) return false;
  if (prLifecycleStatus === 'merged' || prLifecycleStatus === 'closed') return false;
  return (TERMINAL_STATUSES as readonly string[]).includes(taskStatus);
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

export interface DeadZoneSweepResult {
  total: number;
  sparked: number;
  exhausted: number;
  skipped: number;
}

/**
 * Sweep for dead-zone PRs.
 *
 * Optionally scoped to a single workspace (useful for testing or targeted repair).
 * Called from the pr-reconcile cron — same HTTP handler, no second GitHub poller.
 */
export async function sweepDeadZonePrs(workspaceId?: string): Promise<DeadZoneSweepResult> {
  // Find workers with open PRs
  const candidates = await db.query.workers.findMany({
    where: and(
      workspaceId ? eq(workers.workspaceId, workspaceId) : undefined,
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
      sql`COALESCE(${workers.prLifecycleStatus}, 'pr_open') NOT IN ('closed', 'merged')`,
      isNotNull(workers.taskId),
    ),
    columns: {
      id: true,
      taskId: true,
      workspaceId: true,
      prUrl: true,
      prNumber: true,
      prLifecycleStatus: true,
      branch: true,
      conflictDetectedAt: true,
    },
    with: {
      task: {
        columns: {
          id: true,
          title: true,
          description: true,
          context: true,
          missionId: true,
          status: true,
        },
      },
    },
  });

  // Filter to dead-zone candidates: open PR + terminal task
  const deadZone = candidates.filter((w) => {
    const task = (w as any).task;
    if (!task) return false;
    return isDeadZoneCandidate(task.status, w.prUrl, null, w.prLifecycleStatus);
  });

  const result: DeadZoneSweepResult = {
    total: deadZone.length,
    sparked: 0,
    exhausted: 0,
    skipped: 0,
  };
  if (deadZone.length === 0) return result;

  // Group by workspace to share a single GitHub installation token
  const byWorkspace = new Map<string, typeof deadZone>();
  for (const w of deadZone) {
    if (!byWorkspace.has(w.workspaceId)) byWorkspace.set(w.workspaceId, []);
    byWorkspace.get(w.workspaceId)!.push(w);
  }

  for (const [wsId, wsWorkers] of byWorkspace) {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, wsId),
      columns: { id: true, repo: true, name: true, gitConfig: true, webhookConfig: true, githubInstallationId: true, githubRepoId: true },
      with: { githubInstallation: { columns: { installationId: true } } },
    });

    if (!workspace?.repo || !workspace.githubInstallation?.installationId) {
      result.skipped += wsWorkers.length;
      continue;
    }

    if (!isAutoResolveMergeConflictsEnabled(workspace.gitConfig)) {
      result.skipped += wsWorkers.length;
      continue;
    }

    const { repo } = workspace;
    const { installationId } = workspace.githubInstallation;

    for (const worker of wsWorkers) {
      if (!worker.prNumber) { result.skipped++; continue; }

      const task = (worker as any).task as {
        id: string;
        title: string;
        description: string | null;
        context: Record<string, unknown> | null;
        missionId: string | null;
        status: string;
      };

      try {
        const pr = await githubApi(
          installationId,
          `/repos/${repo}/pulls/${worker.prNumber}`,
        ) as {
          state: string;
          merged: boolean;
          merged_at: string | null;
          mergeable_state: string | null;
          head: { sha: string };
        };

        const now = new Date();

        // PR closed or merged — stamp and skip
        if (pr.state === 'closed') {
          if (pr.merged && pr.merged_at) {
            await db.update(workers)
              .set({ mergedAt: new Date(pr.merged_at), prLifecycleStatus: 'merged', prLastCheckedAt: now, updatedAt: now })
              .where(eq(workers.id, worker.id));
          } else {
            await db.update(workers)
              .set({ prLifecycleStatus: 'closed', prLastCheckedAt: now, updatedAt: now })
              .where(eq(workers.id, worker.id));
          }
          result.skipped++;
          continue;
        }

        // PR open but not dirty — update check time and skip
        if (pr.mergeable_state !== 'dirty') {
          await db.update(workers)
            .set({ prLastCheckedAt: now, updatedAt: now })
            .where(eq(workers.id, worker.id));
          result.skipped++;
          continue;
        }

        // Dirty — stamp prLifecycleStatus='conflict' + conflictDetectedAt (if new)
        if (worker.prLifecycleStatus !== 'conflict') {
          await db.update(workers)
            .set({
              prLifecycleStatus: 'conflict',
              conflictDetectedAt: now,
              prLastCheckedAt: now,
              updatedAt: now,
            })
            .where(eq(workers.id, worker.id));
        } else {
          await db.update(workers)
            .set({ prLastCheckedAt: now, updatedAt: now })
            .where(eq(workers.id, worker.id));
        }

        const headSha = pr.head.sha;

        // Count conflict retry tasks for this PR (active and completed)
        const allRetries = await db.query.tasks.findMany({
          where: and(
            eq(tasks.workspaceId, wsId),
            eq(tasks.conflictRetryPrNumber, worker.prNumber),
          ),
          columns: { id: true, status: true },
          orderBy: [desc(tasks.createdAt)],
        });

        const activeRetryCount = allRetries.filter((t) =>
          ['pending', 'assigned', 'in_progress'].includes(t.status),
        ).length;
        const completedRetryCount = allRetries.filter((t) =>
          (TERMINAL_STATUSES as readonly string[]).includes(t.status),
        ).length;

        const action = classifyDeadZoneAction(activeRetryCount, completedRetryCount);

        if (action === 'skip') {
          result.skipped++;
          continue;
        }

        if (action === 'exhaust') {
          result.exhausted++;
          console.log(
            `[dead-zone-sweep] PR #${worker.prNumber} in workspace ${wsId}: retries exhausted (${completedRetryCount}/${DEFAULT_MAX_CONFLICT_ITERATIONS}) — surfacing as BLOCKED`,
          );
          continue;
        }

        // action === 'spark' — build and dispatch a conflict retry task
        const retryTask = buildConflictRetryTask({
          originalTask: {
            id: task.id,
            title: task.title,
            description: task.description,
            workspaceId: wsId,
            // Inject the completed retry count so buildConflictRetryTask picks the
            // right iteration number. The terminal task has no conflictIteration of
            // its own — we derive it from existing retry tasks for this PR.
            context: {
              ...(task.context || {}),
              conflictIteration: completedRetryCount,
              maxConflictIterations: DEFAULT_MAX_CONFLICT_ITERATIONS,
            },
            missionId: task.missionId,
          },
          worker: {
            id: worker.id,
            branch: worker.branch,
            prNumber: worker.prNumber,
          },
          headSha,
          repoFullName: repo,
        });

        if (!retryTask) {
          // buildConflictRetryTask returned null — iteration cap reached.
          // classifyDeadZoneAction should have caught this, but guard anyway.
          result.exhausted++;
          continue;
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
          // Unique index hit: same (workspaceId, prNumber, headSha) already exists.
          // A previous sweep already sparked for this head SHA.
          result.skipped++;
          continue;
        }

        await dispatchNewTask(newTask, workspace);
        result.sparked++;
        console.log(
          `[dead-zone-sweep] sparked task ${newTask.id} for PR #${worker.prNumber}@${headSha.slice(0, 7)} (iteration ${retryTask.context.conflictIteration}/${retryTask.context.maxConflictIterations})`,
        );
      } catch (err) {
        console.warn(
          `[dead-zone-sweep] error processing worker ${worker.id} PR #${worker.prNumber}:`,
          err,
        );
        result.skipped++;
      }
    }
  }

  return result;
}
