/**
 * Before a mission's final verification files repairs (Living Specs c5a2c67b
 * R-4): a failed task whose work a completed replacement already did is
 * cancelled as superseded by it, and every task that waited on it waits on
 * the replacement instead. Otherwise a dependent (a surface audit, a later
 * step) stays blocked on a failure nobody will fix, and the verification files
 * a repair for work that already landed.
 *
 * Which failures are replaced is mission-task-superseded.ts's call
 * (computeSupersededFailedTasks): a title-equivalent retry that completed with
 * a merged PR, or a later audit that replaced a failed one. Only a failure
 * with a named completed replacement is touched; a failure whose PR merged
 * with no replacement task, or a waived audit, has no task to re-point to and
 * is left as it is.
 */
import { dependencyFailureOf } from '@buildd/core/dependency-failure';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';

export interface CleanupDependent {
  id: string;
  status: string;
  dependsOn: string[];
  result: unknown;
  roleSlug: string | null;
  /** A worker ever ran it: a failure of its own, not only its dependency's. */
  ran: boolean;
}

export interface CleanupPlan {
  cancel: Array<{ taskId: string; replacementId: string }>;
  repoint: Array<{ taskId: string; from: string[]; dependsOn: string[]; reopen: boolean; wake: boolean }>;
}

/**
 * Pure. `replacements` maps a failed task to its completed replacement.
 * A dependent's edges to a cancelled task move to its replacement (deduped,
 * never to itself). A never-run audit the cascade failed for that task goes
 * back to pending, the same rule reopenChecksFailedBy applies when a
 * dependency completes; a builder failed that way is left alone.
 */
export function planSupersededCleanup(replacements: ReadonlyMap<string, string>, dependents: readonly CleanupDependent[]): CleanupPlan {
  const cancel = [...replacements].map(([taskId, replacementId]) => ({ taskId, replacementId }));
  const repoint: CleanupPlan['repoint'] = [];
  for (const d of dependents) {
    if (replacements.has(d.id)) continue;
    const from = d.dependsOn.filter((id) => replacements.has(id));
    if (!from.length) continue;
    const dependsOn = [...new Set(d.dependsOn.map((id) => replacements.get(id) ?? id))].filter((id) => id !== d.id);
    const blockedBy = dependencyFailureOf(d.result)?.taskId;
    const reopen = d.status === 'failed' && !d.ran && d.roleSlug === VISUAL_AUDITOR_ROLE_SLUG && !!blockedBy && replacements.has(blockedBy);
    repoint.push({ taskId: d.id, from, dependsOn, reopen, wake: reopen || d.status === 'pending' });
  }
  return { cancel, repoint };
}

export interface CleanupDeps {
  /** The mission's failed tasks mapped to their completed replacement, where one exists. */
  replacementsOf(missionId: string, workspaceId: string): Promise<Map<string, string>>;
  dependentsOf(missionId: string, taskIds: readonly string[]): Promise<CleanupDependent[]>;
  /** Cancel `taskId` as superseded by `replacementId`, only while it is still failed. True when it was. */
  cancelSuperseded(taskId: string, replacementId: string, actor: string): Promise<boolean>;
  /** Swap the edges, only while the dependent still holds them; reopen it when asked. True when written. */
  repoint(r: CleanupPlan['repoint'][number]): Promise<boolean>;
  wake(taskId: string): Promise<void>;
}

export interface CleanupResult {
  cancelled: Array<{ taskId: string; replacementId: string }>;
  repointed: Array<{ taskId: string; from: string[]; reopened: boolean }>;
}

export async function cleanUpSupersededFailures(
  missionId: string,
  workspaceId: string,
  actor: string,
  deps?: CleanupDeps,
): Promise<CleanupResult> {
  const d = deps ?? await defaultDeps();
  const replacements = await d.replacementsOf(missionId, workspaceId);
  if (replacements.size === 0) return { cancelled: [], repointed: [] };
  const plan = planSupersededCleanup(replacements, await d.dependentsOf(missionId, [...replacements.keys()]));
  const cancelled: CleanupResult['cancelled'] = [];
  for (const c of plan.cancel) if (await d.cancelSuperseded(c.taskId, c.replacementId, actor)) cancelled.push(c);
  // Only edges to a task actually cancelled here move: one a person retried meanwhile stays.
  const gone = new Set(cancelled.map((c) => c.taskId));
  const repointed: CleanupResult['repointed'] = [];
  for (const r of plan.repoint) {
    if (!r.from.every((id) => gone.has(id))) continue;
    if (!(await d.repoint(r))) continue;
    repointed.push({ taskId: r.taskId, from: r.from, reopened: r.reopen });
    if (r.wake) await d.wake(r.taskId);
  }
  return { cancelled, repointed };
}

/** One line per change, for the verification's prompt. */
export function describeCleanup(r: CleanupResult): string[] {
  return [
    ...r.cancelled.map((c) => `- Cancelled failed task ${c.taskId}: superseded by completed task ${c.replacementId}.`),
    ...r.repointed.map((p) => `- Task ${p.taskId} now waits on the replacement of ${p.from.join(', ')}${p.reopened ? ', and is back in the queue' : ''}.`),
  ];
}

async function defaultDeps(): Promise<CleanupDeps> {
  const [{ db }, { tasks, workers }, { and, eq, sql }, { computeSupersededFailedTasks }, { applyTaskCancelSideEffects }, { wakeTask }, { deliveryOwnedTaskSql, taskCols }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
    import('@/lib/mission-task-superseded'),
    import('@/lib/task-cancel'),
    import('@/lib/dispatch-authority'),
    import('@/lib/workflow/pr-fact-scope'),
  ]);
  // A task whose PR delivery is still live is the kernel's to move, not this sweep's.
  const notLiveDelivery = sql`NOT ${deliveryOwnedTaskSql(taskCols(), { live: true })}`;
  return {
    replacementsOf: async (missionId, workspaceId) => {
      const failed = await db.select({ id: tasks.id, title: tasks.title, subjectPrNumber: tasks.subjectPrNumber, createdAt: tasks.createdAt, roleSlug: tasks.roleSlug })
        .from(tasks).where(and(eq(tasks.missionId, missionId), eq(tasks.status, 'failed'))).limit(200);
      const superseded = await computeSupersededFailedTasks(missionId, workspaceId, failed);
      const out = new Map<string, string>();
      for (const s of superseded.values()) if (s.supersedingTaskId && s.supersedingTaskId !== s.taskId) out.set(s.taskId, s.supersedingTaskId);
      return out;
    },
    dependentsOf: async (missionId, ids) => {
      const rows = await db.select({
        id: tasks.id, status: tasks.status, dependsOn: tasks.dependsOn, result: tasks.result, roleSlug: tasks.roleSlug,
        ran: sql<boolean>`EXISTS (SELECT 1 FROM ${workers} WHERE ${workers.taskId} = ${tasks.id})`,
      }).from(tasks).where(and(
        eq(tasks.missionId, missionId),
        sql`${tasks.dependsOn}::jsonb ?| ${sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`}`,
      ));
      return rows.map((r) => ({ ...r, dependsOn: Array.isArray(r.dependsOn) ? r.dependsOn : [], ran: !!r.ran }));
    },
    cancelSuperseded: async (taskId, replacementId, actor) => {
      const cancellation = { reason: `Superseded by task ${replacementId}`, supersededBy: { taskId: replacementId }, actor, at: new Date().toISOString() };
      const [row] = await db.update(tasks)
        .set({ status: 'cancelled', context: sql`coalesce(${tasks.context}, '{}'::jsonb) || ${JSON.stringify({ cancellation })}::jsonb`, updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, 'failed'), notLiveDelivery))
        .returning({ id: tasks.id, workspaceId: tasks.workspaceId, missionId: tasks.missionId });
      if (!row) return false;
      await applyTaskCancelSideEffects({ id: row.id, workspaceId: row.workspaceId, missionId: row.missionId ?? null });
      return true;
    },
    repoint: async (r) => {
      const [row] = await db.update(tasks)
        .set({
          dependsOn: r.dependsOn,
          ...(r.reopen ? { status: 'pending' as const, result: null, claimedBy: null, claimedAt: null, expiresAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(and(
          eq(tasks.id, r.taskId),
          sql`${tasks.dependsOn}::jsonb @> ${JSON.stringify(r.from)}::jsonb`,
          ...(r.reopen ? [eq(tasks.status, 'failed'), notLiveDelivery] : []),
        ))
        .returning({ id: tasks.id });
      return !!row;
    },
    wake: (taskId) => wakeTask(taskId, 'dependency.satisfied'),
  };
}
