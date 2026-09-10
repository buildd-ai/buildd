// Ship state — the delivery dimension mission health does not answer.
//
// `deriveMissionHealth` answers *is work moving* and `goalCriteriaState` answers
// *is it correct*. Neither answers *is it out*: `deriveMissionHealth` returns
// `'shipped'` for `mission.status === 'completed'`, which is a row transition
// and says nothing about production. This is the missing third question
// (docs/design/mission-delivery-arc.md, "The missing dimension: ship state").
//
// Derived, never stored — no new columns. The mission's merged work is joined
// through `release_tasks` → `releases` and partitioned on `releases.state =
// 'healthy'`; `missions.release_attempted_at` (migration 0143) supplies the
// "an attempt was recorded" half of `release_failed`.
//
// Doctrine borrowed wholesale from `@/lib/release-state` (spec §9): the
// archetype branch is decided WITHOUT issuing a release query, so
// `not_applicable` — this classifier's `none` — is reachable with zero reads
// (AC-42), and a release-capable mission with nothing to show is NEVER computed
// the same way as an archetype-`none` one (§9.1). `shouldQueryRelease` is reused
// rather than re-branched so the two classifiers cannot drift apart about which
// archetypes are release-capable. The merged partition carries
// `notMissionIntegrationMerge()` for the same reason: "did this merge reach
// trunk" is one question with one implementation, in
// `@buildd/core/release-queue-scope`, not a fifth private variant here.
import { db } from '@buildd/core/db';
import { tasks, workers, releases, releaseTasks } from '@buildd/core/db/schema';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { detectArchetype, type ReleaseArchetype } from '@buildd/core/release-archetype';
import type { WorkspaceReleaseConfig, WorkspaceGitConfig } from '@buildd/core/db/schema';
import { shouldQueryRelease } from '@/lib/release-state';
import { notMissionIntegrationMerge } from '@buildd/core/release-queue-scope';

export type MissionShipState =
  /** Open work remains — the mission is not finished producing its diff. */
  | 'building'
  /** Everything merged; no `healthy` release carries it and none was attempted. */
  | 'merged_unshipped'
  /** A `healthy` release contains the mission's merged work. */
  | 'shipped'
  /** An attempt was recorded and no `healthy` release contains the work. */
  | 'release_failed'
  /** Workspace-less mission, or archetype `none`. Renders nothing, permanently. */
  | 'not_applicable';

/**
 * What the single evidence query returns. Counts are per-task and DISTINCT: a
 * task can have many workers and many release edges, so a naive join would
 * multiply rows and inflate every count.
 */
export interface MissionShipEvidence {
  /** Mission tasks in a non-terminal status. */
  openWorkCount: number;
  /**
   * Mission tasks with at least one worker whose merge could have reached trunk.
   * Merges into a mission integration branch (Option A′) are excluded — see the
   * query below and `@buildd/core/release-queue-scope`.
   */
  mergedTaskCount: number;
  /** Mission tasks carried by at least one `healthy` release. */
  shippedTaskCount: number;
  /** `missions.release_attempted_at IS NOT NULL`. */
  releaseAttempted: boolean;
}

export interface MissionShipStateScope {
  workspaceId: string | null;
  archetype: ReleaseArchetype;
}

/**
 * The one branch reachable without release data. Call this BEFORE loading
 * evidence, not after (the §9 AC-42 discipline applied to delivery).
 *
 * A workspace-less mission has no release ledger to join at all; `none` is the
 * archetype that never resolves into anything else.
 */
export function shouldQueryMissionShipState(scope: MissionShipStateScope): boolean {
  if (!scope.workspaceId) return false;
  return shouldQueryRelease(scope.archetype);
}

export function classifyMissionShipState(input: {
  archetype: ReleaseArchetype;
  workspaceId: string | null;
  /** Evidence query output. Not consulted when the scope is not release-capable. */
  evidence: MissionShipEvidence | null;
}): MissionShipState {
  // Decided without touching release data, so `not_applicable` never needs a
  // query to reach its rendering — and stays correct even if a caller loaded
  // evidence first.
  if (!shouldQueryMissionShipState(input)) return 'not_applicable';

  const e = input.evidence;
  // Release-capable but nothing loaded. `building` — NOT `not_applicable`,
  // which would make a mission that simply hasn't produced anything yet
  // indistinguishable from one whose workspace can never release (§9.1).
  if (!e) return 'building';

  // Precedence is deliberate and ordered:
  //
  // 1. Open work first. Under the design's A' shape (one mission, one diff, one
  //    merge) `partially_shipped` is structurally impossible, and it is not
  //    reintroduced here: while any non-terminal work remains the mission is
  //    `building`, even if earlier tasks already rode out in a release. A
  //    partial healthy join must never be allowed to read as `shipped`.
  if (e.openWorkCount > 0) return 'building';

  // 2. Shipped beats a recorded attempt. `release_failed` is defined as "an
  //    attempt was recorded, no healthy release contains the work", so a
  //    successful retry after a failed attempt must not read as failed forever
  //    (`release_attempted_at` is not cleared on success).
  if (e.shippedTaskCount > 0) return 'shipped';

  // 3. An attempt with an empty healthy set — the silent-and-permanent failure
  //    from the design doc's problem observation §2, given a name.
  if (e.releaseAttempted) return 'release_failed';

  // 4. Merged, unattempted, unshipped: the state the release queue is for.
  if (e.mergedTaskCount > 0) return 'merged_unshipped';

  // Nothing merged, nothing open, nothing attempted — a mission that has not
  // produced a diff yet.
  return 'building';
}

/**
 * A task's status is not its terminal state in every sense (its PR's state can
 * lag — see lib/mission-completion.ts), but for "is there open work" the status
 * set is the right and cheap answer. Kept in sync with
 * `TERMINAL_TASK_STATUSES` in lib/mission-completion.ts, which is module-private
 * there; duplicated deliberately rather than widening that module's API.
 */
const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export interface MissionShipStateMission {
  id: string;
  workspaceId: string | null;
  releaseAttemptedAt: Date | string | null;
}

export interface MissionShipStateWorkspace {
  name: string | null;
  releaseConfig: WorkspaceReleaseConfig | null | unknown;
  gitConfig: WorkspaceGitConfig | null | unknown;
}

/**
 * One query, no new columns. Returns `not_applicable` without issuing anything
 * when the mission has no workspace or the workspace's archetype is `none`.
 */
export async function loadMissionShipState(
  mission: MissionShipStateMission,
  workspace: MissionShipStateWorkspace | null,
): Promise<MissionShipState> {
  const archetype: ReleaseArchetype = workspace
    ? detectArchetype({
        name: workspace.name,
        releaseConfig: (workspace.releaseConfig as WorkspaceReleaseConfig | null) ?? null,
        gitConfig: (workspace.gitConfig as WorkspaceGitConfig | null) ?? null,
      })
    : 'none';

  const scope: MissionShipStateScope = { workspaceId: mission.workspaceId, archetype };

  // The early return IS the contract: no baseline read, no release read.
  if (!shouldQueryMissionShipState(scope)) {
    return classifyMissionShipState({ ...scope, evidence: null });
  }

  const [row] = await db
    .select({
      openWorkCount: sql<number>`count(distinct case when ${tasks.status} not in ${TERMINAL_TASK_STATUSES} then ${tasks.id} end)::int`,
      // `mergedAt` alone answers "a PR of this task merged", not "it reached
      // trunk". Under Option A′ a mission's task PRs merge into the mission's
      // integration branch, so without the base-ref filter a mission with every
      // task PR merged and its mission PR still open reads `merged_unshipped` —
      // "the release queue is what's next" — while trunk has none of it. Same
      // fragment as the four release-queue-depth queries, deliberately: this is
      // the fifth caller of the same question.
      mergedTaskCount: sql<number>`count(distinct case when ${workers.mergedAt} is not null and ${notMissionIntegrationMerge()} then ${tasks.id} end)::int`,
      shippedTaskCount: sql<number>`count(distinct case when ${releases.state} = 'healthy' then ${tasks.id} end)::int`,
    })
    .from(tasks)
    .leftJoin(workers, eq(workers.taskId, tasks.id))
    .leftJoin(releaseTasks, eq(releaseTasks.taskId, tasks.id))
    .leftJoin(releases, eq(releases.id, releaseTasks.releaseId))
    .where(eq(tasks.missionId, mission.id));

  return classifyMissionShipState({
    ...scope,
    evidence: row
      ? {
          openWorkCount: Number(row.openWorkCount ?? 0),
          mergedTaskCount: Number(row.mergedTaskCount ?? 0),
          shippedTaskCount: Number(row.shippedTaskCount ?? 0),
          releaseAttempted: mission.releaseAttemptedAt != null,
        }
      : null,
  });
}

/**
 * Batched "which of these missions have at least one task in a `healthy`
 * release" — one query for a whole page of missions, not `loadMissionShipState`
 * called in a loop. Used for rollup signals (initiative pulse's
 * `shippedThisWeek`) that only need the boolean, not the full five-state
 * machine, and cannot afford an N+1 per mission on a list page.
 *
 * Deliberately skips the archetype gate `shouldQueryMissionShipState` guards:
 * a workspace whose archetype cannot release never gets a `releases` row in the
 * first place (B11), so the join below already returns nothing for it without
 * a second lookup to establish that.
 */
export async function loadShippedMissionIds(missionIds: string[]): Promise<Set<string>> {
  if (missionIds.length === 0) return new Set();

  const rows = await db
    .select({ missionId: tasks.missionId })
    .from(tasks)
    .innerJoin(releaseTasks, eq(releaseTasks.taskId, tasks.id))
    .innerJoin(releases, eq(releases.id, releaseTasks.releaseId))
    .where(and(inArray(tasks.missionId, missionIds), eq(releases.state, 'healthy')))
    .groupBy(tasks.missionId);

  return new Set(rows.map((r) => r.missionId).filter((id): id is string => !!id));
}
