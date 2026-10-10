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
 *   2a. GitHub says mergeable_state = 'dirty' (merge conflicts), OR
 *   2b. GitHub says mergeable_state = 'blocked' AND at least one check-run on the
 *       current head SHA has completed with a failure conclusion (CI-failing / red).
 *       Pending/queued checks do NOT qualify — only completed failures.
 *   3a. No active conflict retry → spark one (reuse conflict-retry machinery).
 *   3b. Retries exhausted → stamp prLifecycleStatus='conflict'; escalation inbox
 *       surfaces it as a BLOCKED card.
 *
 * Kernel-owned PRs (workflow-state-kernel §13.4, §14): step 3 is the kernel's.
 * A dirty one goes through `dispatchConflictRetry` (T12); a red one is left to
 * the kernel CI family. Steps 3a/3b and the insert below are legacy-only.
 *
 * Dedup:
 *   - Active-retry check prevents filing while one is in flight.
 *   - The (workspaceId, conflictRetryPrNumber, conflictRetryHeadSha) unique index
 *     in the tasks table prevents duplicate tasks for the same PR head SHA.
 */

import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, isNotNull, isNull, sql, desc } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import {
  buildConflictRetryTask,
  dispatchConflictRetry,
  isAutoResolveMergeConflictsEnabled,
  releaseSpentConflictRetryKey,
} from '@/lib/conflict-retry';
import { kernelDeliveryForPr } from '@/lib/workflow/authority';
import { policyValue } from '@/lib/policy-overrides';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { inheritAttemptIdentity } from '@/lib/attempt-identity';
import {
  WORKSPACE_INSTALLATION_WITH,
  pickWorkspaceRepoIdentity,
  installationIdForRepo,
} from '@/lib/workspace-installation';
import { resolvePrRepo } from '@/lib/repo-scope';
import { recordPrFact } from '@buildd/core/pr-facts';

// ── Pure predicates ───────────────────────────────────────────────────────────

export type DeadZoneAction = 'spark' | 'exhaust' | 'skip';

/** Terminal task statuses — no worker will resume them. */
const TERMINAL_STATUSES = TERMINAL_TASK_STATUSES;

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
  maxIterations: number = policyValue('maxConflictIterations'),
): DeadZoneAction {
  if (activeRetryCount > 0) return 'skip';
  if (completedRetryCount >= maxIterations) return 'exhaust';
  return 'spark';
}

/**
 * Pure: is a PR in a "red" (CI-failing) state?
 *
 * A PR is red when mergeable_state is 'blocked' AND at least one check run on
 * the current head SHA has completed with a failure conclusion. Transient
 * states (queued, in_progress) are NOT failures — a PR blocked only because
 * checks are still running must not trigger a spark.
 *
 * This distinguishes "failing" from "not yet green":
 *   failing   → status='completed', conclusion in {failure, action_required, timed_out}
 *   pending   → status in {queued, in_progress}, conclusion=null  → not red
 *   never ran → no check runs at all                              → not red
 */
export function isRedPr(
  mergeableState: string | null,
  checkRuns: Array<{ status: string; conclusion: string | null }>,
): boolean {
  if (mergeableState !== 'blocked') return false;
  return checkRuns.some(
    (cr) =>
      cr.status === 'completed' &&
      (cr.conclusion === 'failure' ||
        cr.conclusion === 'action_required' ||
        cr.conclusion === 'timed_out'),
  );
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
  if (
    prLifecycleStatus === 'merged'
    || prLifecycleStatus === 'closed'
    || prLifecycleStatus === 'unresolvable'
  ) return false;
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
      sql`COALESCE(${workers.prLifecycleStatus}, 'pr_open') NOT IN ('closed', 'merged', 'unresolvable')`,
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

  /** Repo → installation, memoized for the sweep. See pr-reconcile.ts. */
  const installationByRepo = new Map<string, number | null>();
  const resolveInstallationCached = async (repo: string): Promise<number | null> => {
    if (!installationByRepo.has(repo)) {
      installationByRepo.set(repo, await installationIdForRepo(repo).catch(() => null));
    }
    return installationByRepo.get(repo) ?? null;
  };

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
      with: WORKSPACE_INSTALLATION_WITH,
    });

    // Repo-mediated pointer first. The legacy workspaces.githubInstallationId FK
    // survives an App reinstall pointing at a dead installation whose token
    // 404s on every call — see lib/workspace-installation.ts.
    // No workspace row means there is nothing to dispatch a retry against,
    // regardless of what the PR looks like.
    if (!workspace) {
      result.skipped += wsWorkers.length;
      continue;
    }

    // Repo identity from the linked github_repos row, not the free-text column.
    const wsIdentity = pickWorkspaceRepoIdentity(workspace);
    const workspaceInstallationId = wsIdentity.installationId;
    const workspaceRepo = wsIdentity.fullName;

    if (!isAutoResolveMergeConflictsEnabled(workspace.gitConfig)) {
      result.skipped += wsWorkers.length;
      continue;
    }

    for (const worker of wsWorkers) {
      if (!worker.prNumber) { result.skipped++; continue; }

      // The PR's own repo, from its prUrl, with the workspace only as a
      // fallback — see lib/repo-scope.ts. `workspaces.repo` holds a URL rather
      // than a slug, so interpolating it built a path that 404'd on every
      // call: no conflict was ever detected here, and no BLOCKED card ever
      // came from this sweep.
      const repo = resolvePrRepo({ prUrl: worker.prUrl, workspaceRepo });
      if (!repo) { result.skipped++; continue; }

      const installationId =
        (repo === workspaceRepo ? workspaceInstallationId : null)
        ?? await resolveInstallationCached(repo)
        ?? workspaceInstallationId;
      if (!installationId) { result.skipped++; continue; }

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
          base?: { ref?: string };
        };

        const now = new Date();

        // PR closed or merged — stamp and skip
        if (pr.state === 'closed') {
          // A fact for the fact cache (recordPrFact): terminal wins, GitHub's merged_at.
          await recordPrFact(
            { workerId: worker.id },
            pr.merged && pr.merged_at ? { kind: 'merged', mergedAt: pr.merged_at } : { kind: 'closed' },
          );
          await db.update(workers).set({ prLastCheckedAt: now, updatedAt: now }).where(eq(workers.id, worker.id));
          result.skipped++;
          continue;
        }

        const isDirty = pr.mergeable_state === 'dirty';
        let isRed = false;

        if (!isDirty && pr.mergeable_state === 'blocked') {
          // Folded into the existing per-PR fetch — no second poller.
          const checkRunsData = await githubApi(
            installationId,
            `/repos/${repo}/commits/${pr.head.sha}/check-runs`,
          ) as { check_runs: Array<{ status: string; conclusion: string | null }> };
          isRed = isRedPr(pr.mergeable_state, checkRunsData.check_runs ?? []);
        }

        // PR is clean, pending, or blocked for non-CI reasons — skip.
        if (!isDirty && !isRed) {
          await db.update(workers)
            .set({ prLastCheckedAt: now, updatedAt: now })
            .where(eq(workers.id, worker.id));
          result.skipped++;
          continue;
        }

        // Dirty is a conflict; red CI is a CI fact, not a conflict (§18.2: the
        // old write mapped both to `conflict`). conflictDetectedAt is first-seen.
        await recordPrFact(
          { workerId: worker.id },
          isDirty ? { kind: 'conflict' } : { kind: 'ci', status: 'ci_failed', headSha: pr.head.sha, currentHeadSha: pr.head.sha },
        );
        await db.update(workers).set({ prLastCheckedAt: now, updatedAt: now }).where(eq(workers.id, worker.id));

        const headSha = pr.head.sha;

        // A kernel-owned PR (workflow-state-kernel §14: no two authorities). Its
        // owner task is normally `completed` while the delivery is live, so it
        // reaches here, but the conflict decision is the kernel's (T12): it goes
        // through the one conflict door, which applies ConflictObserved against
        // the delivery's own budget and ledger. Red CI is the kernel's CI family
        // (T10), not a conflict, so nothing is filed for it here. An authority
        // read error throws into the per-PR catch below: nothing is filed.
        if (await kernelDeliveryForPr(wsId, repo, worker.prNumber)) {
          if (!isDirty) { result.skipped++; continue; }
          const out = await dispatchConflictRetry({
            workerId: worker.id,
            taskId: task.id,
            prNumber: worker.prNumber,
            headSha,
            repoFullName: repo,
            workspaceId: wsId,
          });
          if (out.dispatched) result.sparked++;
          else if (out.exhausted || out.refreshExhausted) result.exhausted++;
          else result.skipped++;
          console.log(
            `[dead-zone-sweep] PR #${worker.prNumber}@${headSha.slice(0, 7)} is kernel-owned — routed through the conflict door (${out.dispatched ? 'dispatched' : 'not dispatched'}${out.kernel?.state ? `, ${out.kernel.state}` : ''})`,
          );
          continue;
        }

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
            `[dead-zone-sweep] PR #${worker.prNumber} in workspace ${wsId}: retries exhausted (${completedRetryCount}/${policyValue('maxConflictIterations')}) — surfacing as BLOCKED`,
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
              maxConflictIterations: policyValue('maxConflictIterations'),
            },
            missionId: task.missionId,
          },
          worker: {
            id: worker.id,
            branch: worker.branch,
            prNumber: worker.prNumber,
          },
          headSha,
          // The runner's pre-merge reads it (context.prBase).
          prBase: pr.base?.ref ?? null,
          repoFullName: repo,
        });

        if (!retryTask) {
          // buildConflictRetryTask returned null — iteration cap reached.
          // classifyDeadZoneAction should have caught this, but guard anyway.
          result.exhausted++;
          continue;
        }

        // An attempt inherits the backend, role, routing kind and phase (Rule P1-7)
        // of the task it re-attempts — same as conflict-retry.ts's own insert.
        const identity = await inheritAttemptIdentity(retryTask.parentTaskId);

        const insertRetry = () => db
          .insert(tasks)
          .values({
            workspaceId: retryTask.workspaceId,
            title: retryTask.title,
            description: retryTask.description,
            parentTaskId: retryTask.parentTaskId,
            missionId: retryTask.missionId,
            ...identity,
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

        let [newTask] = await insertRetry();
        // An earlier retry that ended on this same head without pushing still
        // holds the key. The PR is still dirty, so spark the next attempt. The
        // retry count above caps how many attempts can run.
        if (!newTask && await releaseSpentConflictRetryKey(wsId, worker.prNumber, headSha)) {
          [newTask] = await insertRetry();
        }

        if (!newTask) {
          // Unique index hit: a concurrent caller sparked for this head SHA.
          result.skipped++;
          continue;
        }

        await announceTaskCreated(newTask, workspace);
        await wakeTask(newTask.id, 'task.created');
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
