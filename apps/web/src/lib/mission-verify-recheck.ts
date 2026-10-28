/**
 * Verification runs by itself (Navigation d25d923d R-19): when the build
 * completes, after each repair merges and whenever the merged result changes,
 * not only when something attempts to complete the mission. There is no Run
 * verification button; `Re-check` in ⋯ covers a fix made outside buildd.
 *
 * The decision is pure (`recheckReason`); `recheckMissionAfterMerge` reads the
 * mission's tasks and asks `ensureCriteriaVerdict`, which keeps its own
 * debounce and the owner's `autoVerify: false`.
 */
import { db } from '@buildd/core/db';
import { missions, tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { deliverableRole, isBuildDeliverable } from '@buildd/core/mission-helpers';
import { isBuildComplete } from '@/lib/mission-checks';
import { isMissionPrTask } from '@buildd/core/mission-integration';

export type RecheckReason = 'build_complete' | 'repair_merged' | 'target_changed';

type TaskRow = {
  id: string; status: string; title: string | null; taskClass: string | null; roleSlug?: string | null;
  context?: unknown; kind?: string | null; mode?: string | null; category?: string | null; creationSource?: string | null;
};

/** Missions whose result nobody checks any more. */
const CLOSED = new Set(['cancelled', 'archived']);

/**
 * Why a merge of `mergedTaskId` owes the mission a new verdict, or null.
 * - The mission PR merged: the result now sits on its target.
 * - A repair merged: what it fixed is checked again.
 * - A build task merged and every build task has landed: the build is
 *   complete, or the merged result it built changed.
 * A build merge while other build work is still open owes nothing yet.
 */
export function recheckReason(mergedTaskId: string, rows: readonly TaskRow[]): RecheckReason | null {
  const merged = rows.find(t => t.id === mergedTaskId);
  if (!merged) return null;
  if (isMissionPrTask(merged)) return 'target_changed';
  const role = deliverableRole(merged);
  if (role === 'repair') return 'repair_merged';
  if (role !== 'build' || !isBuildDeliverable(merged)) return null;
  const build = rows.filter(t => t.status !== 'cancelled' && isBuildDeliverable(t));
  const done = build.filter(t => t.status === 'completed' || t.id === mergedTaskId).length;
  return isBuildComplete({ done, total: build.length }) ? 'build_complete' : null;
}

export interface RecheckDeps {
  mission(id: string): Promise<{ status: string; goalCriteria: unknown } | null>;
  tasks(missionId: string): Promise<TaskRow[]>;
  ensure(missionId: string, trigger: string): Promise<unknown>;
}

const dbDeps: RecheckDeps = {
  mission: async (id) => (await db.select({ status: missions.status, goalCriteria: missions.goalCriteria }).from(missions).where(eq(missions.id, id)).limit(1))[0] ?? null,
  tasks: (missionId) => db.select({
    id: tasks.id, status: tasks.status, title: tasks.title, taskClass: tasks.taskClass, roleSlug: tasks.roleSlug,
    context: tasks.context, kind: tasks.kind, mode: tasks.mode, category: tasks.category, creationSource: tasks.creationSource,
  }).from(tasks).where(eq(tasks.missionId, missionId)) as Promise<TaskRow[]>,
  ensure: async (missionId, trigger) => {
    const { ensureCriteriaVerdict } = await import('@/lib/mission-criteria-eval');
    return ensureCriteriaVerdict(missionId, { trigger });
  },
};

/** After a merge into a mission: re-check its criteria when the merge owes a verdict. Never throws. */
export async function recheckMissionAfterMerge(missionId: string, mergedTaskId: string, deps: RecheckDeps = dbDeps): Promise<RecheckReason | null> {
  try {
    const mission = await deps.mission(missionId);
    if (!mission || CLOSED.has(mission.status)) return null;
    if (!Array.isArray(mission.goalCriteria) || mission.goalCriteria.length === 0) return null;
    const reason = recheckReason(mergedTaskId, await deps.tasks(missionId));
    if (!reason) return null;
    await deps.ensure(missionId, reason);
    return reason;
  } catch (err) {
    console.error(`[verify-recheck] mission ${missionId.slice(0, 8)}: re-check after merge failed`, err instanceof Error ? err.message : err);
    return null;
  }
}
