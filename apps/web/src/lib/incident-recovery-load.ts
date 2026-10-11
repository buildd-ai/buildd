/**
 * DB loaders for the task adapter (`incident-recovery-refs.ts`): which tasks
 * carry an incident ref, and the incident's view for each. Server only.
 */
import { INCIDENT_RECOVERY_CONTEXT_KEY, readIncidentRecoveryRef, taskRecoveryView, type TaskRecoveryView } from './incident-recovery-refs';

/**
 * The recovery view for each task that carries a ref, by task id. Two reads:
 * the tasks' context and the incidents named. Never throws: a failed read
 * leaves every question as it is.
 */
export async function loadTaskRecoveryViews(taskIds: readonly string[], opts: { timeZone?: string } = {}): Promise<Map<string, TaskRecoveryView>> {
  const out = new Map<string, TaskRecoveryView>();
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const [{ db }, { tasks, failureIncidents }, { inArray, sql, and }] = await Promise.all([
      import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
    ]);
    const rows = await db
      .select({ id: tasks.id, context: tasks.context })
      .from(tasks)
      .where(and(inArray(tasks.id, ids), sql`${tasks.context} -> ${INCIDENT_RECOVERY_CONTEXT_KEY} is not null`));
    const refs = rows.flatMap(r => {
      const ref = readIncidentRecoveryRef(r.context);
      return ref ? [{ taskId: r.id, ref }] : [];
    });
    if (refs.length === 0) return out;
    const incidents = await db.query.failureIncidents.findMany({
      where: inArray(failureIncidents.id, [...new Set(refs.map(r => r.ref.incidentId))]),
    });
    const byId = new Map(incidents.map(i => [i.id, i]));
    for (const { taskId, ref } of refs) {
      const view = taskRecoveryView(byId.get(ref.incidentId) ?? null, { timeZone: opts.timeZone });
      if (view) out.set(taskId, view);
    }
  } catch (err) {
    console.warn('[incident-recovery-refs] read failed (non-fatal):', (err as Error)?.message ?? err);
  }
  return out;
}

/** As `loadTaskRecoveryViews`, in the viewer's zone: one wait for a page's parallel group. */
export async function loadTaskRecoveryViewsForViewer(taskIds: readonly string[], viewer: { userId: string | null; teamId: string | null }): Promise<Map<string, TaskRecoveryView>> {
  const { getViewerTimezone } = await import('./team-timezone');
  const timeZone = await getViewerTimezone(viewer.userId, viewer.teamId).catch(() => 'UTC');
  return loadTaskRecoveryViews(taskIds, { timeZone });
}

/** Task ids whose open question recovery has superseded. */
export async function loadSupersededQuestionTaskIds(taskIds: readonly string[]): Promise<Set<string>> {
  const views = await loadTaskRecoveryViews(taskIds);
  return new Set([...views].filter(([, v]) => v.supersedesQuestion).map(([id]) => id));
}
