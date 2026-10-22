import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { missions, specRevisions, specs, tasks, workers } from '@buildd/core/db/schema';
import { and, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { isBuildDeliverable, isStandardCriterion } from '@buildd/core/mission-helpers';
import type { GoalCriterion, LivingSpecGoalCriterion } from '@buildd/shared';

/**
 * Standards (Living Specs D-43, Navigation R-17's Standards half): specs a
 * person marks with metadata `standard: true`. Their criteria apply to every
 * change in the workspace.
 *
 * - The mark is a person's: an owner or admin of the workspace's team, from
 *   their own dashboard session. An agent run, an API key or an OAuth bearer
 *   session (an agent may be driving it) is refused (`standardMarkRefusal`).
 * - When a mission's build starts (its first build task is claimed), the
 *   workspace's standards, at their approved revisions, are snapshotted onto
 *   it as `living_spec` goal entries tagged `role: 'standard'`. Never
 *   retroactively: a mission whose build already started keeps no standards,
 *   and a standard marked later does not reach a mission already building.
 * - Their verdicts are mission-level rows in `spec_outcome_verdicts`, recorded
 *   by the final verification like an outcome spec's (./mission-outcome.ts).
 * - Completion: `canCompleteMission` reads them on their own. Shadow (logged,
 *   reported on the decision) unless STANDARDS_GATE=enforce (./standards-gate.ts,
 *   kept free of the database so the completion gate and pages import it cheaply).
 */

export { standardsGateEnforced, standardsHoldOf, standardsLine, type StandardsHold, type StandardsLine, type StandardItem, type StandardItemStatus } from './standards-gate';

const GONE = ['retired', 'superseded'] as const;

export const STANDARD_MARK_REFUSAL = 'Marking a spec a standard is a person\'s decision: an owner or admin of this team, from their own session. An agent run or API key cannot set or clear it.';

/**
 * Who may set or clear `standard` (pure): a dashboard session (`user`) of an
 * owner or admin of the workspace's team. Every other caller is refused.
 */
export function standardMarkRefusal(input: { callerKind: 'user' | 'account' | 'system'; ownerOrAdmin: boolean }): string | null {
  return input.callerKind === 'user' && input.ownerOrAdmin ? null : STANDARD_MARK_REFUSAL;
}

/** A workspace standard at its approved revision. */
export interface StandardPin { specId: string; specRevisionId: string; revision: number; contentHash: string; title: string }

/** The goal entry a standard becomes on a mission. */
export function standardCriterion(p: StandardPin): LivingSpecGoalCriterion {
  return {
    type: 'living_spec', specId: p.specId, specRevisionId: p.specRevisionId, revision: p.revision, contentHash: p.contentHash,
    role: 'standard', label: `Standard "${p.title}" revision ${p.revision}`,
  };
}

/**
 * Pure: the mission's criteria with the workspace's standards added. A mission
 * that already carries standards is never re-snapshotted, and a spec the
 * mission selected as its outcome is not added again (it is gated as the
 * outcome, which is stricter).
 */
export function planStandardsSnapshot(stored: readonly GoalCriterion[], standards: readonly StandardPin[]): { criteria: GoalCriterion[]; added: LivingSpecGoalCriterion[] } {
  if (stored.some(isStandardCriterion)) return { criteria: [...stored], added: [] };
  const selected = new Set(stored.flatMap((c) => (c.type === 'living_spec' ? [c.specId] : [])));
  const added = standards.filter((s) => !selected.has(s.specId)).map(standardCriterion);
  return { criteria: [...stored, ...added], added };
}

/** The workspace's standards: specs marked `standard`, with an approved revision, not retired. */
export async function loadWorkspaceStandards(workspaceId: string): Promise<StandardPin[]> {
  const rows = await db.select({
    specId: specs.id, title: specs.title, specRevisionId: specRevisions.id, revision: specRevisions.revision, contentHash: specRevisions.contentHash,
  }).from(specs)
    .innerJoin(specRevisions, and(eq(specRevisions.specId, specs.id), eq(specRevisions.revision, specs.approvedRevision)))
    .where(and(
      eq(specs.workspaceId, workspaceId),
      isNotNull(specs.approvedRevision),
      notInArray(specs.status, [...GONE]),
      sql`${specs.metadata}->>'standard' = 'true'`,
    ));
  return rows.sort((a, b) => a.title.localeCompare(b.title));
}

export type StandardsSnapshotResult =
  | { kind: 'snapshotted'; added: number }
  | { kind: 'skipped'; reason: 'no_mission' | 'not_active' | 'already' | 'not_build' | 'build_already_started' | 'no_standards' | 'raced' };

const TASK_ROLE_COLUMNS = {
  id: tasks.id, title: tasks.title, roleSlug: tasks.roleSlug, context: tasks.context, taskClass: tasks.taskClass,
  kind: tasks.kind, mode: tasks.mode, creationSource: tasks.creationSource, category: tasks.category,
} as const;

/**
 * Snapshot the workspace's standards onto a mission when its build starts:
 * called after `startingTaskId` was claimed. Snapshots only when that task is
 * a build deliverable, it has no earlier attempt, and no other build task of
 * the mission was ever started; so a mission already building when this
 * shipped, or when a standard was marked, never gains one. The write lands
 * only while the criteria are still what was read.
 */
export async function snapshotMissionStandards(missionId: string, startingTaskId: string): Promise<StandardsSnapshotResult> {
  const [mission] = await db.select({ id: missions.id, workspaceId: missions.workspaceId, status: missions.status, goalCriteria: missions.goalCriteria })
    .from(missions).where(eq(missions.id, missionId)).limit(1);
  if (!mission?.workspaceId) return { kind: 'skipped', reason: 'no_mission' };
  if (mission.status !== 'active') return { kind: 'skipped', reason: 'not_active' };
  const stored = Array.isArray(mission.goalCriteria) ? (mission.goalCriteria as GoalCriterion[]) : [];
  if (stored.some(isStandardCriterion)) return { kind: 'skipped', reason: 'already' };
  // Most workspaces mark none: one indexed read, and nothing else is asked.
  const standards = await loadWorkspaceStandards(mission.workspaceId);
  if (standards.length === 0) return { kind: 'skipped', reason: 'no_standards' };

  const started = await db.selectDistinct(TASK_ROLE_COLUMNS).from(tasks)
    .innerJoin(workers, eq(workers.taskId, tasks.id))
    .where(eq(tasks.missionId, missionId));
  const starting = started.find((t) => t.id === startingTaskId);
  if (!starting || !isBuildDeliverable(starting)) return { kind: 'skipped', reason: 'not_build' };
  if (started.some((t) => t.id !== startingTaskId && isBuildDeliverable(t))) return { kind: 'skipped', reason: 'build_already_started' };
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(workers).where(eq(workers.taskId, startingTaskId));
  if (n > 1) return { kind: 'skipped', reason: 'build_already_started' };

  const plan = planStandardsSnapshot(stored, standards);
  if (plan.added.length === 0) return { kind: 'skipped', reason: 'no_standards' };

  const res = await db.execute(sql`
    UPDATE missions SET goal_criteria = ${JSON.stringify(plan.criteria)}::jsonb, updated_at = now()
    WHERE id = ${missionId}::uuid AND coalesce(goal_criteria, '[]'::jsonb) = ${JSON.stringify(stored)}::jsonb
    RETURNING id`);
  if ((((res as { rows?: unknown[] }).rows) ?? []).length === 0) return { kind: 'skipped', reason: 'raced' };
  return { kind: 'snapshotted', added: plan.added.length };
}


/**
 * After a claim's response: snapshot standards for each claimed mission task
 * (the snapshot itself decides whether the build just started). Never blocks
 * or fails the claim.
 */
export function scheduleStandardsSnapshots(claims: ReadonlyArray<{ taskId: string; missionId: string | null }>): void {
  const due = claims.filter((c): c is { taskId: string; missionId: string } => !!c.missionId);
  if (due.length === 0) return;
  const run = () => Promise.all(due.map((c) => snapshotMissionStandards(c.missionId, c.taskId)
    .then((r) => { if (r.kind === 'snapshotted') console.log(`[standards] mission ${c.missionId.slice(0, 8)}: ${r.added} standard(s) snapshotted at build start`); })
    .catch((err) => console.error(`[standards] snapshot failed for mission ${c.missionId.slice(0, 8)} (not blocking):`, err))));
  try {
    after(run);
  } catch {
    // Outside a request scope (scripts, tests): run now, detached.
    void run();
  }
}
