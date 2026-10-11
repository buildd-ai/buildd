/**
 * The task adapter to a failure incident's recovery (docs/specs/failure-incident-recovery.md
 * §16.4, §17.2). A task blocked by an incident carries
 * `context.incidentRecovery = { incidentId, generation }`, written by the
 * recovery family through the existing context merge. Task surfaces read the
 * incident's assessment through it, via the same projection as the incident
 * page, and never parse the question text.
 *
 * The key is `incidentRecovery`, not `recoveryRef`: `tasks.context.recoveryRef`
 * already holds the runner's WIP checkpoint (`origin/<branch>@<sha>`).
 */
import { projectIncident, type IncidentForView, type IncidentPhase, type IncidentProjection, type ProjectIncidentOpts } from './incident-view';

export const INCIDENT_RECOVERY_CONTEXT_KEY = 'incidentRecovery';

export interface IncidentRecoveryRef {
  incidentId: string;
  generation: number;
}

/** The ref on a task's context, or null. Anything malformed reads as none. */
export function readIncidentRecoveryRef(context: unknown): IncidentRecoveryRef | null {
  const raw = context && typeof context === 'object' ? (context as Record<string, unknown>)[INCIDENT_RECOVERY_CONTEXT_KEY] : null;
  if (!raw || typeof raw !== 'object') return null;
  const { incidentId, generation } = raw as Record<string, unknown>;
  return typeof incidentId === 'string' && typeof generation === 'number' ? { incidentId, generation } : null;
}

export interface TaskRecoveryView {
  incidentId: string;
  href: string;
  phase: IncidentPhase;
  stateWord: string;
  sentence: string;
  ownerLabel: IncidentProjection['ownerLabel'];
  pill: IncidentProjection['pill'];
  nextCheckAt: string | null;
  /**
   * Recovery owns this task's next step, so an open question the worker asked
   * about the same failure is stale: no surface offers its controls or counts
   * it. False only while the assessment asks a person a concrete decision.
   */
  supersedesQuestion: boolean;
  /** Completion progress must not count this task as done (an audit blocked by a repair stays unmet). */
  holdsCompletion: boolean;
}

/** Pure. The task's view of its incident; null when the incident could not be read (unknown stays explicit). */
export function taskRecoveryView(incident: IncidentForView | null | undefined, opts: ProjectIncidentOpts = {}): TaskRecoveryView | null {
  if (!incident) return null;
  // Task surfaces never decide Needs You membership, so no verdict is read here.
  const p = projectIncident(incident, null, opts);
  return {
    incidentId: incident.id,
    href: `/app/incidents/${incident.id}`,
    phase: p.phase,
    stateWord: p.stateWord,
    sentence: p.sentence,
    ownerLabel: p.ownerLabel,
    pill: p.pill,
    nextCheckAt: p.nextCheckAt,
    supersedesQuestion: p.phase !== 'decision',
    holdsCompletion: p.phase !== 'recovered',
  };
}

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

/** Task ids whose open question recovery has superseded. */
export async function loadSupersededQuestionTaskIds(taskIds: readonly string[]): Promise<Set<string>> {
  const views = await loadTaskRecoveryViews(taskIds);
  return new Set([...views].filter(([, v]) => v.supersedesQuestion).map(([id]) => id));
}
