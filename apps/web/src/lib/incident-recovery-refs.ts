/**
 * The task adapter to a failure incident's recovery (docs/specs/failure-incident-recovery.md
 * §16.4, §17.2). A task blocked by an incident carries
 * `context.incidentRecovery = { incidentId, generation }`, written by the
 * recovery family through the existing context merge. Task surfaces read the
 * incident's assessment through it, via the same projection as the incident
 * page, and never parse the question text.
 *
 * Pure, so client fixtures can draw it; the DB loaders are in
 * `incident-recovery-load.ts`.
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
