import { db } from '@buildd/core/db';
import { missions, missionNotes, tasks, workspaces, githubRepos } from '@buildd/core/db/schema';
import { eq, and, or, lt, isNull, inArray, count } from 'drizzle-orm';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';
import { canCompleteMission } from '@/lib/mission-completion';
import { githubApi } from '@/lib/github';
import { executeRelease } from '@/lib/release-executor';

// Count tasks in the mission that are not yet terminal (pending, assigned, or in_progress).
export async function countPendingTasksForMission(missionId: string): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.missionId, missionId),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress'])
      )
    );
  return Number(result[0]?.count ?? 0);
}

/**
 * How long a claimed-but-uncommitted release attempt is honoured before another
 * caller may reclaim it.
 *
 * Safety bound. A process that dies between phase 1 and phase 2 cannot clear its
 * own attempt, so without a window the mission would be stuck exactly the way
 * the one-phase claim used to stick it. With it, a mission retries a release at
 * most about once per window — not once per task completion — and only while
 * `releasedAt IS NULL`. Once `releasedAt` is set nothing retries at all.
 */
export const MISSION_RELEASE_ATTEMPT_STALE_MS = 30 * 60 * 1000;

/** Why a release attempt ended, for the durable record. */
export type MissionReleaseFailure =
  | 'not_configured'
  | 'no_installation'
  | 'dispatch_failed'
  | 'execute_failed'
  | 'strategy_unhandled'
  | 'skipped';

/**
 * Phase 1 of the release claim: take ownership of the attempt.
 *
 * Claims `releaseAttemptedAt`, NOT `releasedAt`. Exactly one concurrent caller
 * wins. Returns true iff this caller owns the attempt and must go on to call
 * either {@link commitMissionRelease} or {@link abandonMissionReleaseAttempt}.
 *
 * Reclaimable only when the prior attempt is older than
 * {@link MISSION_RELEASE_ATTEMPT_STALE_MS}, and never once `releasedAt` is set.
 */
export async function claimMissionReleaseAttempt(missionId: string): Promise<boolean> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - MISSION_RELEASE_ATTEMPT_STALE_MS);
  const claimed = await db
    .update(missions)
    .set({ releaseAttemptedAt: now })
    .where(
      and(
        eq(missions.id, missionId),
        // Terminal: a released mission is never re-released.
        isNull(missions.releasedAt),
        or(
          isNull(missions.releaseAttemptedAt),
          lt(missions.releaseAttemptedAt, staleBefore),
        ),
      )
    )
    .returning({ id: missions.id });
  return claimed.length > 0;
}

/**
 * Phase 2, success: the dispatch or merge reported success, so record the ship.
 *
 * Guarded on `isNull(releasedAt)` so a reclaimed-stale duplicate cannot move the
 * timestamp of a release that already landed.
 */
export async function commitMissionRelease(missionId: string): Promise<void> {
  const now = new Date();
  await db
    .update(missions)
    .set({ releasedAt: now, updatedAt: now })
    .where(and(eq(missions.id, missionId), isNull(missions.releasedAt)));
}

/**
 * Phase 2, failure: release the claim and record why.
 *
 * Clears `releaseAttemptedAt` so the next completion can try again, and writes a
 * `decision` note so the reason is legible from the mission feed. Before this,
 * every one of these paths was a `console.log` against an already-consumed
 * claim: the mission read as released, nothing was deployed, and no surface
 * showed either fact.
 *
 * Note insertion is best-effort — a failed note must not mask the release
 * failure or, worse, leave the claim held.
 */
export async function abandonMissionReleaseAttempt(
  missionId: string,
  code: MissionReleaseFailure,
  reason: string,
): Promise<void> {
  await db
    .update(missions)
    .set({ releaseAttemptedAt: null, updatedAt: new Date() })
    .where(and(eq(missions.id, missionId), isNull(missions.releasedAt)));

  console.error(`[mission-release] mission ${missionId}: release attempt failed — ${code}: ${reason}`);

  try {
    await db.insert(missionNotes).values({
      missionId,
      authorType: 'system',
      type: 'decision',
      title: 'Mission release attempt failed',
      body:
        `${reason}\n\n` +
        `Reason code: \`${code}\`. The mission is NOT marked released and the ` +
        `release will be retried on the next task completion. ` +
        `Fix the release configuration (workspace → Config → Release) or fire it ` +
        `manually with \`trigger_release\`.`,
      actorLabel: 'release trigger (on_mission_complete)',
    });
  } catch (err) {
    console.error(`[mission-release] mission ${missionId}: failed to record release decision note:`, err);
  }
}

// Called after a task completes. If the workspace trigger is `on_mission_complete`
// and the task belongs to a mission that is now all-terminal, fires exactly one
// release via the atomic claim + executes the appropriate strategy.
export async function fireMissionReleaseIfComplete(
  workspaceId: string,
  missionId: string,
  taskId: string,
  workerId: string,
): Promise<void> {
  // Fetch workspace config to check trigger policy
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { releaseConfig: true, githubRepoId: true },
  });

  const trigger = workspace?.releaseConfig?.trigger ?? 'every_merge';
  if (trigger !== 'on_mission_complete') return;

  // Check that all tasks in the mission have reached terminal state. This bar is
  // stricter than the completion predicate on purpose: it counts housekeeping
  // rows too, because a release should not fire while any row of the mission is
  // still moving.
  const pending = await countPendingTasksForMission(missionId);
  if (pending > 0) return;

  // Same predicate as every completion path — including the goal-criteria gate.
  // Before this, a mission could read COMPLETE (heartbeat's word) while the
  // release gate refused to ship, and the only thing protecting production was
  // that this side happened to be stricter. Now both sides ask one question, and
  // this side keeps its extra bar above.
  // `evaluateCriteria: false` — a release READS a verdict, it does not manufacture
  // one. Evaluating here would let the release trigger dispatch verification tasks
  // and spend tokens; the completion path (which calls back into this function on
  // success) is what produces verdicts.
  const decision = await canCompleteMission(missionId, {
    path: 'release_trigger',
    acceptCompleted: true,
    evaluateCriteria: false,
  });
  if (!decision.ok) {
    console.log(
      `[mission-release] mission ${missionId}: not releasing — ${decision.code}: ${decision.reason}`
    );
    return;
  }

  // Phase 1: claim the ATTEMPT, not the release. Every exit below either commits
  // (success) or abandons (failure) — the claim is never simply dropped.
  const won = await claimMissionReleaseAttempt(missionId);
  if (!won) return;

  const releaseConfig = workspace?.releaseConfig ?? null;
  const resolution = resolveReleaseStrategy(releaseConfig);
  if (!resolution.ok) {
    await abandonMissionReleaseAttempt(
      missionId,
      'not_configured',
      `Workspace ${workspaceId} has no usable release strategy: ${resolution.message}`,
    );
    return;
  }

  if (resolution.strategy.kind === 'workflow_dispatch') {
    // Dispatch the release workflow directly (no per-task merge needed)
    const repo = workspace?.githubRepoId
      ? await db.query.githubRepos.findFirst({
          where: eq(githubRepos.id, workspace.githubRepoId),
          with: { installation: true },
        })
      : null;

    if (!repo?.installation) {
      await abandonMissionReleaseAttempt(
        missionId,
        'no_installation',
        'The workspace has no linked GitHub installation, so the release workflow cannot be dispatched.',
      );
      return;
    }

    const { workflowFile, ref, inputs } = resolution.strategy;
    try {
      await githubApi(
        repo.installation.installationId,
        `/repos/${repo.fullName}/actions/workflows/${workflowFile}/dispatches`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref, inputs: { force: 'false', ...inputs } }),
        },
      );
      console.log(`[mission-release] mission ${missionId}: dispatched ${workflowFile}@${ref}`);
      await commitMissionRelease(missionId);
    } catch (err) {
      await abandonMissionReleaseAttempt(
        missionId,
        'dispatch_failed',
        `Dispatching ${workflowFile}@${ref} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (resolution.strategy.kind === 'branch_merge') {
    // For branch_merge: delegate to executeRelease with isMissionRelease=true
    // so the trigger policy is bypassed. Uses the completing task's info to
    // determine the source branch / release PR.
    try {
      const result = await executeRelease({ taskId, workerId, workspaceId, isMissionRelease: true });
      console.log(`[mission-release] mission ${missionId}: branch_merge result: ${result.status} — ${result.message}`);
      // 'skipped' is a refusal, not a release. It is also the DEFAULT outcome on
      // this repo's own topology (a releaseBranch workspace skips any task whose
      // `release` flag is 'inherit'), which is precisely the case the one-phase
      // claim used to burn silently.
      if (result.status === 'skipped') {
        await abandonMissionReleaseAttempt(missionId, 'skipped', result.message);
      } else {
        await commitMissionRelease(missionId);
      }
    } catch (err) {
      await abandonMissionReleaseAttempt(
        missionId,
        'execute_failed',
        `executeRelease threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    await abandonMissionReleaseAttempt(
      missionId,
      'strategy_unhandled',
      `Release strategy '${resolution.strategy.kind}' is not handled by the mission release path.`,
    );
  }
}
