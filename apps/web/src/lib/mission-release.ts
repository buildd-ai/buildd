import { db } from '@buildd/core/db';
import { missions, tasks, workspaces, githubRepos } from '@buildd/core/db/schema';
import { eq, and, isNull, inArray, count } from 'drizzle-orm';
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

// Attempt an atomic claim on missions.releasedAt so exactly one concurrent
// task completion fires the release. Returns true iff this caller won the claim.
async function claimMissionRelease(missionId: string): Promise<boolean> {
  const claimed = await db
    .update(missions)
    .set({ releasedAt: new Date() })
    .where(
      and(
        eq(missions.id, missionId),
        isNull(missions.releasedAt)
      )
    )
    .returning({ id: missions.id });
  return claimed.length > 0;
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

  // Atomic dedup: only the first caller to set releasedAt fires the release
  const won = await claimMissionRelease(missionId);
  if (!won) return;

  const releaseConfig = workspace?.releaseConfig ?? null;
  const resolution = resolveReleaseStrategy(releaseConfig);
  if (!resolution.ok) {
    console.log(`[mission-release] workspace ${workspaceId}: not configured — ${resolution.message}`);
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
      console.error(`[mission-release] mission ${missionId}: no GitHub installation — skipping`);
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
    } catch (err) {
      console.error(`[mission-release] mission ${missionId}: workflow dispatch failed:`, err);
    }
  } else if (resolution.strategy.kind === 'branch_merge') {
    // For branch_merge: delegate to executeRelease with isMissionRelease=true
    // so the trigger policy is bypassed. Uses the completing task's info to
    // determine the source branch / release PR.
    try {
      const result = await executeRelease({ taskId, workerId, workspaceId, isMissionRelease: true });
      console.log(`[mission-release] mission ${missionId}: branch_merge result: ${result.status} — ${result.message}`);
    } catch (err) {
      console.error(`[mission-release] mission ${missionId}: executeRelease failed:`, err);
    }
  } else {
    console.log(`[mission-release] mission ${missionId}: strategy ${resolution.strategy.kind} not handled in mission release`);
  }
}
