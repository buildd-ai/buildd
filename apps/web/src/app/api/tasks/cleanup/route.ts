import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks, workerHeartbeats, workspaces, accounts } from '@buildd/core/db/schema';
import { eq, and, lt, inArray, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { cleanupStaleWorkers, cleanupStuckWaitingInput, cleanupUnresumedAnswers } from '@/lib/stale-workers';
import { checkWorkerDeliverables, getWorkerDeliverableArtifactCount } from '@/lib/worker-deliverables';
import { resolveCompletedTask } from '@/lib/task-dependencies';
import { consumesRetryAttempt } from '@/lib/worker-exit-taxonomy';
import { releaseAndNotify } from '@/lib/path-claim-release';
import { FORCE_CLAIM_CONTEXT_KEY } from '@/lib/force-claim';
import { runnerWorkerOnly } from '@/lib/interactive-worker-liveness';
import { RUNNER_STALE_CUTOFF_MS } from '@buildd/shared';
import { wakeTask } from '@/lib/dispatch-authority';

// Cap consecutive cleanup-driven retries. Without this, a task that keeps
// erroring (stuck-detector aborts, heartbeat expiries, etc.) bounces back to
// pending forever — 2026-05-25 incident: a misrouted task burned 4 workers
// over 3 hours before being killed manually.
const MAX_TASK_FAILURES = 3;

async function resetOrFailTask(taskId: string, now: Date, reason: string) {
  // Only chargeable failures count against the cap — budget/infra/never-started/
  // silent-start exits reflect external constraints, not task defects. The
  // exclusion list lives in worker-exit-taxonomy (it used to be duplicated here
  // and had already drifted: sandbox_mount_gap and condition_unmet were charged
  // by this rail while stale-workers.ts exempted them).
  // Workers predating exitCause (null) default to code_failure for safety.
  const prior = await db.query.workers.findMany({
    where: and(
      eq(workers.taskId, taskId),
      inArray(workers.status, ['error', 'failed']),
    ),
    columns: { id: true, exitCause: true },
  });
  const failureCount = prior.filter(w => consumesRetryAttempt(w.exitCause)).length;

  if (failureCount >= MAX_TASK_FAILURES) {
    const existing = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { context: true, workspaceId: true },
    });
    const existingCtx = (existing?.context || {}) as Record<string, unknown>;
    await db
      .update(tasks)
      .set({
        status: 'failed',
        claimedBy: null,
        claimedAt: null,
        expiresAt: null,
        updatedAt: now,
        context: {
          ...existingCtx,
          terminalError: 'retry_cap_exceeded',
          terminalReason: `${failureCount} worker failures (${reason}); aborting auto-retry`,
        },
      })
      .where(eq(tasks.id, taskId));

    // This is a TERMINAL write, so it must run the same post-terminal resolution
    // every other terminal writer runs (lib/stale-workers.ts resolveStaleTask,
    // workers/[id] completion, interrupt). Without it cascadeDependencyFailure
    // never fires and every task depending on this one stays pending forever:
    // `failed` is not in DEP_SATISFYING_STATUSES, so the claim gate blocks the
    // dependents indefinitely behind a task that can never complete. The mission
    // loop and parent-children rollup are missed for the same reason.
    //
    // Awaited (dependents must be consistent before we report counts) but
    // non-fatal: one bad cascade must not abort the rest of the cleanup pass.
    try {
      await resolveCompletedTask(taskId, existing?.workspaceId ?? '');
    } catch (err) {
      console.error(`[cleanup] dependency cascade failed for task ${taskId}:`, err);
    }
    return 'failed' as const;
  }

  await db
    .update(tasks)
    .set({
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      expiresAt: null,
      updatedAt: now,
      // A requeue ends the claim, so a force claim's audit goes with it.
      context: sql`COALESCE(${tasks.context}, '{}'::jsonb) - ${FORCE_CLAIM_CONTEXT_KEY}`,
    })
    .where(eq(tasks.id, taskId));
  await wakeTask(taskId, 'task.requeued');
  return 'pending' as const;
}

/**
 * What one cleanup call may touch. An admin-level API key reaches only its own
 * account's workers/heartbeats and its team's workspaces' tasks; a session
 * reaches the accounts and workspaces of every team the user belongs to.
 * A task is changed only when its workspace is in scope, even when the worker
 * holding it belongs to the caller.
 * The cross-tenant sweep lives in the cron jobs, never behind this route.
 */
interface CleanupScope {
  accountIds: string[];
  workspaceIds: string[];
}

async function resolveCleanupScope(
  user: { id: string } | null,
  apiAccount: { id: string; teamId: string } | null,
): Promise<CleanupScope> {
  const teamIds = await resolveAccountTeamIds(user, apiAccount);
  if (teamIds.length === 0) return { accountIds: [], workspaceIds: [] };

  const [teamWorkspaces, teamAccounts] = await Promise.all([
    db.query.workspaces.findMany({
      where: inArray(workspaces.teamId, teamIds),
      columns: { id: true },
    }),
    apiAccount
      ? Promise.resolve([{ id: apiAccount.id }])
      : db.query.accounts.findMany({
          where: inArray(accounts.teamId, teamIds),
          columns: { id: true },
        }),
  ]);
  return {
    accountIds: teamAccounts.map(a => a.id),
    workspaceIds: teamWorkspaces.map(w => w.id),
  };
}

// POST /api/tasks/cleanup - Clean up stale workers and orphaned tasks.
// Auth: a session, or an admin-level API key. Every phase is bounded to the
// caller's scope (see resolveCleanupScope).
export async function POST(req: NextRequest) {
  // Auth check: session or admin API key
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);

  const hasSessionAuth = !!user;
  const hasAdminToken = hasTokenRouteAdminAccess(apiAccount, req, 'tasks:admin');

  if (!hasSessionAuth && !hasAdminToken) {
    return NextResponse.json(
      { error: 'Unauthorized - requires session auth or admin-level API token' },
      { status: 401 }
    );
  }

  // An admin key acts as its account; otherwise the session user acts.
  const scope = await resolveCleanupScope(
    hasAdminToken ? null : user,
    hasAdminToken ? apiAccount : null,
  );
  const hasAccounts = scope.accountIds.length > 0;
  const hasWorkspaces = scope.workspaceIds.length > 0;

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  let stalledWorkers = 0;
  let orphanedTasks = 0;

  // 1. Workers stuck in running/starting with no update for > 1 hour.
  // Runner workers only: an interactive (MCP-claimed) worker's updatedAt moves
  // on MCP activity, not runner syncs, and it has its own longer TTL in
  // cleanupStaleWorkers (step 3). One hour of a person's local agent working
  // without an MCP call is normal (friction 92866723).
  const stalledRunning = !hasAccounts ? [] : await db.query.workers.findMany({
    where: and(
      inArray(workers.accountId, scope.accountIds),
      inArray(workers.status, ['running', 'starting']),
      lt(workers.updatedAt, oneHourAgo),
      runnerWorkerOnly(),
    ),
    columns: { id: true, taskId: true },
  });

  if (stalledRunning.length > 0) {
    const stalledWorkerIds = stalledRunning.map(w => w.id);
    const stalledTaskIds = stalledRunning.map(w => w.taskId).filter(Boolean) as string[];

    await db
      .update(workers)
      .set({
        status: 'failed',
        exitCause: 'infra_failure',
        error: 'Worker timed out - no activity for over 1 hour',
        completedAt: now,
        updatedAt: now,
      })
      .where(inArray(workers.id, stalledWorkerIds));

    // These workers were just terminated outside PATCH /api/workers/[id], so
    // this sweep must release their path claims itself — a timed-out worker
    // never got to report a real outcome, so nothing landed.
    for (const staleTaskId of stalledTaskIds) {
      await releaseAndNotify(staleTaskId, 'abandoned');
    }

    // Reset associated tasks to pending so they can be re-claimed — but cap
    // retries via resetOrFailTask to break loops on persistently-failing tasks.
    // The worker is the caller's, but its task is only touched when it sits in
    // one of the caller's workspaces (a worker can hold a task elsewhere).
    if (stalledTaskIds.length > 0 && hasWorkspaces) {
      const stillAssigned = await db.query.tasks.findMany({
        where: and(
          inArray(tasks.id, stalledTaskIds),
          inArray(tasks.workspaceId, scope.workspaceIds),
          eq(tasks.status, 'assigned'),
        ),
        columns: { id: true },
      });
      for (const t of stillAssigned) {
        await resetOrFailTask(t.id, now, 'worker timed out — no activity for over 1 hour');
      }
    }

    stalledWorkers = stalledRunning.length;
  }

  // 2. Tasks stuck in 'assigned' with no active workers — reconcile with worker status
  const assignedTasks = !hasWorkspaces ? [] : await db.query.tasks.findMany({
    where: and(
      inArray(tasks.workspaceId, scope.workspaceIds),
      eq(tasks.status, 'assigned'),
    ),
  });

  for (const task of assignedTasks) {
    const taskWorkers = await db.query.workers.findMany({
      where: eq(workers.taskId, task.id),
      columns: { id: true, status: true, prUrl: true, prNumber: true, commitCount: true, filesChanged: true, linesAdded: true, linesRemoved: true, lastCommitSha: true, branch: true },
    });

    // Check for active workers
    const hasActive = taskWorkers.some(w =>
      ['running', 'starting', 'waiting_input', 'idle'].includes(w.status)
    );

    if (hasActive) continue;

    // Check if any worker completed or has deliverables (PR, artifacts, structured output, commits)
    let completedWorker = taskWorkers.find(w => w.status === 'completed');
    if (!completedWorker) {
      // Check errored workers for deliverables
      for (const w of taskWorkers.filter(w => w.status === 'error' || w.status === 'failed')) {
        try {
          const artifactCount = await getWorkerDeliverableArtifactCount(w.id);
          const deliverables = checkWorkerDeliverables(w, { artifactCount });
          if (deliverables.hasAny) {
            completedWorker = w;
            break;
          }
        } catch { /* non-fatal */ }
      }
    }
    if (completedWorker) {
      await db
        .update(tasks)
        .set({
          status: 'completed',
          result: {
            branch: completedWorker.branch,
            commits: completedWorker.commitCount ?? 0,
            sha: completedWorker.lastCommitSha ?? undefined,
            files: completedWorker.filesChanged ?? 0,
            added: completedWorker.linesAdded ?? 0,
            removed: completedWorker.linesRemoved ?? 0,
            prUrl: completedWorker.prUrl ?? undefined,
            prNumber: completedWorker.prNumber ?? undefined,
          },
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
      orphanedTasks++;
      continue;
    }

    // No active workers, no completed workers — reset to pending if stale enough
    if (task.updatedAt < twoHoursAgo) {
      await resetOrFailTask(task.id, now, 'orphaned assigned task with no active workers');
      orphanedTasks++;
    }
  }

  // 3. Per-account stale worker cleanup (15-min threshold + heartbeat check)
  const activeAccountIds = !hasAccounts ? [] : await db.query.workers.findMany({
    where: and(
      inArray(workers.accountId, scope.accountIds),
      inArray(workers.status, ['running', 'starting', 'idle', 'waiting_input']),
    ),
    columns: { accountId: true },
  });
  const uniqueAccountIds = [...new Set(activeAccountIds.map(w => w.accountId).filter(Boolean))] as string[];
  // 4. Clean up workers stuck in waiting_input for 24+ hours — retry without input.
  //    Runs inside the same per-account loop: cleanupStuckWaitingInput used to
  //    take no arguments and sweep every account, so one caller (or one runner's
  //    30-minute cleanup tick) fired the waiting_input timeout for every other
  //    tenant. Cross-account coverage belongs to /api/cron/waiting-input-sweep.
  let waitingInputFailedWorkers = 0;
  let waitingInputRetriedTasks = 0;
  // 4b. Degrade answers that were queued for a parked session and never
  //     acknowledged, so an answer is never silently held by a runner that died
  //     between receiving it and its next sync. See
  //     docs/specs/answered-question-resume.md.
  let unresumedAnswersDegraded = 0;

  // 5. The offline-runner rule (fail workers whose runner went offline) runs
  //    inside cleanupStaleWorkers via failWorkersOfOfflineRunners — the one
  //    shared copy. This route used to carry its own, keyed on ANY heartbeat
  //    row on the account older than 10 minutes: one dead row failed every
  //    in-flight worker under the account's live runner (task 5c0ea9bc).
  let heartbeatOrphans = 0;

  for (const accountId of uniqueAccountIds) {
    try {
      heartbeatOrphans += (await cleanupStaleWorkers(accountId)).heartbeatOrphans;
    } catch {
      // Non-fatal — continue with other accounts
    }
    try {
      const waitingInputResult = await cleanupStuckWaitingInput(accountId);
      waitingInputFailedWorkers += waitingInputResult.failedWorkers;
      waitingInputRetriedTasks += waitingInputResult.retriedTasks;
    } catch {
      // Non-fatal — a failed waiting_input sweep must not skip other accounts
    }
    try {
      unresumedAnswersDegraded += (await cleanupUnresumedAnswers(accountId)).degraded;
    } catch {
      // Non-fatal — same reasoning as the sweep above
    }
  }

  // 7. Delete heartbeat rows of runners presumed dead. Same "not dead" window
  //    the offline-runner rule uses, so "no fresh row" and "row deleted" mean
  //    the same thing and a runner that is merely slow keeps its row.
  const deadRunnerCutoff = new Date(now.getTime() - RUNNER_STALE_CUTOFF_MS);
  const deletedHeartbeats = !hasAccounts ? [] : await db
    .delete(workerHeartbeats)
    .where(and(
      inArray(workerHeartbeats.accountId, scope.accountIds),
      lt(workerHeartbeats.lastHeartbeatAt, deadRunnerCutoff),
    ))
    .returning({ id: workerHeartbeats.id });

  return NextResponse.json({
    cleaned: {
      stalledWorkers,
      orphanedTasks,
      stuckWaitingInput: waitingInputFailedWorkers,
      retriedTasks: waitingInputRetriedTasks,
      unresumedAnswers: unresumedAnswersDegraded,
      heartbeatOrphans,
      staleHeartbeats: deletedHeartbeats.length,
    },
  });
}
