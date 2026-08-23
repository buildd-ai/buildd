/**
 * Shared auto-merge helpers.
 *
 * Used by:
 *   - apps/web/src/app/api/github/webhook/route.ts (CI-green + no-CI paths)
 *   - apps/web/src/app/api/workers/[id]/route.ts   (reviewer approve path)
 */

import { db } from '@buildd/core/db';
import { tasks, missionNotes } from '@buildd/core/db/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { githubApi, mergePullRequest } from '@/lib/github';
import { notifyMissionPrReady } from '@/lib/mission-notifications';
import { notify } from '@/lib/pushover';
import type { MergePolicy } from '@buildd/shared';
import { inspectPullRequestMigrations } from '@/lib/migration-inspector';
import { classifyMergeFailure, dispatchConflictRetry, DEFAULT_MAX_CONFLICT_ITERATIONS } from '@/lib/conflict-retry';

const DEFAULT_AUTO_MERGE_MAX_LINES = 800;

/**
 * Check CI status, deny paths, and diff size for a PR before merging.
 * Returns `{ ok: true }` when all safety rails pass, `{ ok: false, reason }` otherwise.
 */
export async function evaluateAutoMergeSafety(
  installationId: number,
  repoFullName: string,
  prNumber: number,
  headSha: string,
  threshold: MergePolicy['threshold'] | null | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // CI completeness check — verify no check runs are still pending or failing.
  try {
    const checkRunsData = await githubApi(
      installationId,
      `/repos/${repoFullName}/commits/${headSha}/check-runs`,
    );
    const checkRuns: Array<{ name: string; status: string; conclusion: string | null }> =
      checkRunsData?.check_runs ?? [];

    const pendingOrFailed = checkRuns.filter(
      (r) => r.status === 'in_progress' || r.status === 'queued' || r.conclusion === 'failure',
    );
    if (pendingOrFailed.length > 0) {
      return {
        ok: false,
        reason: `CI checks still pending or failed: ${pendingOrFailed.map((r) => r.name).join(', ')}`,
      };
    }

    // Warn if expected named checks are absent — likely means no test suite is configured.
    const runNames = checkRuns.map((r) => r.name.toLowerCase());
    const missingChecks = ['typecheck', 'build', 'test'].filter(
      (c) => !runNames.some((n) => n.includes(c)),
    );
    if (missingChecks.length > 0) {
      console.warn(
        `${repoFullName}#${prNumber}: expected CI checks not found (${missingChecks.join(', ')}) — no test suite configured?`,
      );
    }
  } catch (err) {
    console.warn(`Could not verify check runs for ${repoFullName}@${headSha}:`, err);
  }

  const denyPaths = threshold?.denyPaths ?? [];
  const maxLines = threshold?.maxLines ?? DEFAULT_AUTO_MERGE_MAX_LINES;

  let files: Array<{ filename: string; additions: number; deletions: number }> = [];
  try {
    files = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=300`);
  } catch (err) {
    return { ok: false, reason: `could not fetch PR files: ${err instanceof Error ? err.message : 'unknown'}` };
  }
  if (!Array.isArray(files)) {
    return { ok: false, reason: 'malformed PR files response' };
  }

  if (denyPaths.length > 0) {
    const hits = files.flatMap((file) =>
      denyPaths
        .filter((path) => file.filename.startsWith(path))
        .map((path) => ({ file, path })),
    );
    const schemaSpecific = (path: string) =>
      path.includes('drizzle/') || path === 'packages/core/db/schema.ts';
    const ordinaryHit = hits.find((hit) => !schemaSpecific(hit.path));
    if (ordinaryHit) {
      return { ok: false, reason: `touches protected path (${ordinaryHit.file.filename})` };
    }
    // Inspect whenever a schema-specific rule is configured. The inspector
    // paginates independently, so migrations beyond GitHub's first files page
    // cannot bypass collision/destructive-SQL checks.
    if (denyPaths.some(schemaSpecific)) {
      const migrationSafety = await inspectPullRequestMigrations({
        installationId,
        repoFullName,
        prNumber,
        headSha,
        files,
      });
      if (!migrationSafety.safe) {
        return { ok: false, reason: migrationSafety.reason };
      }
    }
  }

  const NOISE_PATTERNS = [/^packages\/core\/drizzle\/meta\//, /\.lock$/, /^bun\.lockb$/];
  const sourceFiles = files.filter((f) => !NOISE_PATTERNS.some((p) => p.test(f.filename)));
  const totalLines = sourceFiles.reduce((sum, f) => sum + (f.additions || 0) + (f.deletions || 0), 0);
  if (totalLines > maxLines) {
    return {
      ok: false,
      reason: `diff size ${totalLines} source lines > limit ${maxLines} (${files.length - sourceFiles.length} noise files excluded)`,
    };
  }

  // Conflict detection — check GitHub's mergeable_state before attempting merge.
  // 'dirty' = conflicts with base; 'blocked' = branch protection or review required.
  // 'unknown' means GitHub is still computing — treat as a soft pass (do not block permanently).
  try {
    const prData = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    const mergeableState = prData?.mergeable_state as string | undefined;
    if (mergeableState === 'dirty') {
      return { ok: false, reason: `PR has conflicts (mergeable_state: dirty) — needs rebase onto base branch` };
    }
    if (mergeableState === 'blocked') {
      return { ok: false, reason: `PR is blocked (mergeable_state: blocked) — branch protection or review required` };
    }
  } catch (err) {
    console.warn(`Could not check mergeable_state for ${repoFullName}#${prNumber}:`, err);
  }

  return { ok: true };
}

/**
 * Enforce safety rails, then squash-merge the PR.
 * On a conflict (dirty mergeable_state), auto-dispatch a same-branch retry task.
 * On other rail violations, notify the mission feed instead of merging.
 */
export async function tryAutoMergeWorkerPr(params: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  worker: { id: string; taskId: string | null; workspaceId?: string };
  threshold: MergePolicy['threshold'] | null | undefined;
}): Promise<void> {
  const { installationId, repoFullName, prNumber, headSha, worker, threshold } = params;

  const safetyCheck = await evaluateAutoMergeSafety(installationId, repoFullName, prNumber, headSha, threshold);
  if (!safetyCheck.ok) {
    console.log(`Auto-merge blocked for ${repoFullName}#${prNumber}: ${safetyCheck.reason}`);

    // Conflict path: dispatch a same-branch retry rather than asking the human.
    if (classifyMergeFailure(safetyCheck.reason) === 'conflict' && worker.taskId) {
      const workspaceId = worker.workspaceId ?? await resolveWorkspaceId(worker.taskId);
      if (workspaceId) {
        const dispatchResult = await dispatchConflictRetry({
          workerId: worker.id,
          taskId: worker.taskId,
          prNumber,
          headSha,
          repoFullName,
          workspaceId,
        }).catch(err => {
          console.error(`[auto-merge] conflict-retry dispatch failed for PR #${prNumber}:`, err);
          return { dispatched: false } as import('@/lib/conflict-retry').DispatchConflictRetryResult;
        });
        if (dispatchResult.dispatched) return;
        if (dispatchResult.disabled) {
          // Feature disabled — fall through to mission notification so human sees it
        } else if (dispatchResult.exhausted) {
          // Cap reached — escalate to human with a real decision
          await escalateConflictExhaustion(worker.taskId, repoFullName, prNumber, headSha);
          return;
        } else {
          // Duplicate dedup hit — already handling it
          return;
        }
      }
    }

    // Non-conflict or disabled auto-resolve — notify the mission feed
    if (worker.taskId) {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, worker.taskId),
        columns: { missionId: true, title: true },
      });
      if (task?.missionId) {
        await notifyMissionPrReady(task.missionId, {
          title: 'Auto-merge blocked — review needed',
          prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
          prNumber,
          headSha,
          reason: 'auto_merge_blocked',
          message: `${task.title} — ${safetyCheck.reason}`,
        });
      }
    }
    return;
  }

  const result = await mergePullRequest(installationId, repoFullName, prNumber, 'squash');
  if (result.merged) {
    console.log(`Auto-merged PR #${prNumber} on ${repoFullName} for worker ${worker.id}`);
  } else {
    console.warn(`Failed to auto-merge PR #${prNumber} on ${repoFullName}: ${result.message}`);
    // Handle race-condition conflict (PR was clean at eval time but dirty at merge time)
    if (classifyMergeFailure(result.message) === 'conflict' && worker.taskId) {
      const workspaceId = worker.workspaceId ?? await resolveWorkspaceId(worker.taskId);
      if (workspaceId) {
        const dispatchResult = await dispatchConflictRetry({
          workerId: worker.id,
          taskId: worker.taskId,
          prNumber,
          headSha,
          repoFullName,
          workspaceId,
        }).catch(err => {
          console.error(`[auto-merge] conflict-retry dispatch failed for PR #${prNumber}:`, err);
          return { dispatched: false } as import('@/lib/conflict-retry').DispatchConflictRetryResult;
        });
        if (dispatchResult.exhausted && worker.taskId) {
          await escalateConflictExhaustion(worker.taskId, repoFullName, prNumber, headSha);
        }
      }
    }
  }
}

async function resolveWorkspaceId(taskId: string): Promise<string | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { workspaceId: true },
  });
  return task?.workspaceId ?? null;
}

/**
 * Emit escalation when conflict-retry attempts are exhausted.
 *
 * Idempotent: atomic CAS on tasks.context.conflictExhaustedHeadSha ensures
 * exactly one Pushover and one reviewer_escalated note per (taskId, headSha),
 * even when concurrent webhooks or retried requests trigger this simultaneously.
 *
 * Exported so it can be called from all merge paths (auto-merge, MCP merge_pr,
 * human-triggered merge) without writing parallel escalation logic.
 */
export async function escalateConflictExhaustion(
  taskId: string,
  repoFullName: string,
  prNumber: number,
  headSha: string,
): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, missionId: true, title: true, context: true },
  });
  if (!task) return;

  // Atomic dedup: only one escalation per (taskId, headSha)
  const [claimed] = await db
    .update(tasks)
    .set({
      context: sql`COALESCE(context, '{}'::jsonb) || jsonb_build_object('conflictExhaustedHeadSha', ${headSha}::text)`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        or(
          sql`context IS NULL`,
          sql`context->>'conflictExhaustedHeadSha' IS NULL`,
          sql`context->>'conflictExhaustedHeadSha' != ${headSha}`,
        ),
      ),
    )
    .returning({ id: tasks.id });

  if (!claimed) {
    console.log(`[conflict-retry] escalation already fired for task ${taskId} PR #${prNumber}@${headSha.slice(0, 7)}`);
    return;
  }

  const ctx = (task.context ?? {}) as Record<string, unknown>;
  const maxIterations =
    typeof ctx.maxConflictIterations === 'number'
      ? ctx.maxConflictIterations
      : DEFAULT_MAX_CONFLICT_ITERATIONS;
  const prUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;
  const taskUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev'}/app/tasks/${taskId}`;

  // Create reviewer_escalated note → surfaces the PR in the "Waiting on You" inbox
  if (task.missionId) {
    await db.insert(missionNotes).values({
      missionId: task.missionId,
      taskId: task.id,
      authorType: 'system',
      type: 'reviewer_escalated',
      title: `PR #${prNumber} — conflict retries exhausted (${maxIterations}/${maxIterations})`,
      body: `Attempted ${maxIterations} time${maxIterations === 1 ? '' : 's'} to resolve merge conflicts automatically — still conflicted.\n\nChoose one:\n- **Resolve conflicts** — rebase the branch and re-dispatch\n- **Close as superseded** — close this PR and open a fresh one\n- **Abandon PR** — close without replacement`,
      status: 'open',
    });
  }

  // Fire Pushover regardless of mission membership
  notify({
    app: 'tasks',
    title: `PR #${prNumber}: conflict retries exhausted`,
    message: `${task.title}\n${maxIterations} attempt${maxIterations === 1 ? '' : 's'} failed — still has merge conflicts.\nResolve, close as superseded, or abandon.`,
    url: taskUrl,
    urlTitle: 'View task',
    priority: 0,
  });

  console.log(`[conflict-retry] escalated PR #${prNumber}@${headSha.slice(0, 7)} for task ${taskId}`);
}
