/**
 * The click-time re-check (docs/specs/failure-incident-recovery.md §9): a
 * person's choice is applied only to the assessment they were looking at.
 *
 * Re-observe first (the recovery family's own read, source `click`), then
 * project. The click applies only when the generation is unchanged and the
 * fresh projection still offers that capability as one this route applies;
 * otherwise 409 with the fresh projection, so the page re-renders it in place
 * of the stale one. Writes go through the incident store's CAS only.
 */
import type { FailureRecoveryCapability } from '@buildd/shared';
import { applyIncidentAction, type IncidentStorePort, type StoredIncident } from '@/lib/failure-incident-store';
import { projectIncident, type IncidentProjection, type IncidentVerdictView, type ProjectIncidentOpts } from '@/lib/incident-view';
import { buildAutomationState } from '@/lib/failure-incident-recovery-automation';
import { validateRecoveryAction } from '@/lib/failure-incident-recovery-actions';

/** The closed, versioned capability set (§9). Anything else is a 400. */
export const RECOVERY_CAPABILITIES: ReadonlySet<FailureRecoveryCapability> = new Set([
  'dismiss', 'retry_recovery', 'cancel_attempt', 'narrow_subject_manifest', 'narrow_blocker_manifest', 'open_blocker',
]);

export interface IncidentActionDeps {
  port: Pick<IncidentStorePort, 'findById' | 'compareAndSwap'>;
  /** Re-observe and write a fresh assessment (assessIncident, source `click`). Returns the row after it. */
  reassess(incidentId: string): Promise<StoredIncident | null>;
  /** The newest stored verdict, with the generation it was made on. */
  loadVerdict(incident: StoredIncident): Promise<IncidentVerdictView | null>;
  /** Re-run the escalation gate on the changed incident (no page unless it is the person's). */
  regate(incident: StoredIncident): Promise<void>;
  now(): string;
}

export interface IncidentActionRequest {
  capability: FailureRecoveryCapability;
  generation: number | null;
  evidenceRevision?: string | null;
}

export type IncidentActionResult =
  | { status: 200; body: { applied: FailureRecoveryCapability; projection: IncidentProjection; evidenceChanged: boolean } }
  | { status: 404; body: { error: string } }
  | { status: 409; body: { error: 'stale'; reason: 'generation_changed' | 'not_offered' | 'contended'; projection: IncidentProjection } }
  | { status: 422; body: { error: 'not_applied_here'; href: string | null; reason: string | null; projection: IncidentProjection } };

export async function applyIncidentCapability(
  deps: IncidentActionDeps,
  incidentId: string,
  req: IncidentActionRequest,
  view: Omit<ProjectIncidentOpts, 'now'> = {},
): Promise<IncidentActionResult> {
  const fresh = await deps.reassess(incidentId);
  if (!fresh) return { status: 404, body: { error: 'Incident not found' } };
  const project = async (row: StoredIncident) => projectIncident(row, await deps.loadVerdict(row), { ...view, now: deps.now() });
  const projection = await project(fresh);

  if ((req.generation ?? null) !== projection.generation) {
    return { status: 409, body: { error: 'stale', reason: 'generation_changed', projection } };
  }
  const option = projection.options.find(o => o.capability === req.capability);
  if (!option) return { status: 409, body: { error: 'stale', reason: 'not_offered', projection } };
  if (option.mode !== 'post') {
    return { status: 422, body: { error: 'not_applied_here', href: option.href ?? null, reason: option.unavailableReason ?? null, projection } };
  }
  // The one validator every principal goes through (operator-recovery §8.2).
  // FIR's own option set stays the precondition here; the validator adds the
  // team principal's capability fence and its generation check.
  if (fresh.recovery) {
    const v = validateRecoveryAction(
      { kind: 'team', accountId: null, userId: null },
      {
        capability: req.capability === 'dismiss' ? 'decide' : 'retry_recovery',
        target: { incidentId: fresh.id, generation: projection.generation ?? 0 },
        evidenceRevision: projection.evidenceRevision ?? 'none',
        params: req.capability === 'dismiss' ? { capability: 'decide', option: 'dismiss' } : { capability: 'retry_recovery' },
        reason: 'incident page',
      },
      { now: deps.now(), incident: fresh, members: [fresh], causeKey: null, automation: buildAutomationState([], new Date(deps.now())) },
    );
    if (v.result === 'stale') return { status: 409, body: { error: 'stale', reason: 'generation_changed', projection } };
    if (v.result === 'not_supported') return { status: 409, body: { error: 'stale', reason: 'not_offered', projection } };
  }

  let after: StoredIncident | null = null;
  if (req.capability === 'dismiss') {
    after = await deps.port.compareAndSwap(fresh.id, fresh.version, applyIncidentAction(fresh, { type: 'acknowledge' }, deps.now()));
  } else if (req.capability === 'retry_recovery' && fresh.recovery) {
    // A fresh budget for the same generation. The spent keys stay, so no
    // repair key ever runs twice (I-4); the next attempt takes a new one.
    const recovery = { ...fresh.recovery, budget: { ...fresh.recovery.budget, spent: 0 } };
    const reset = await deps.port.compareAndSwap(fresh.id, fresh.version, applyIncidentAction(fresh, { type: 'assess', recovery }, deps.now()));
    after = reset ? await deps.reassess(incidentId) : null;
  }
  if (!after) return { status: 409, body: { error: 'stale', reason: 'contended', projection: await project((await deps.port.findById(incidentId)) ?? fresh) } };

  await deps.regate(after);
  return {
    status: 200,
    body: {
      applied: req.capability,
      projection: await project(after),
      evidenceChanged: !!req.evidenceRevision && req.evidenceRevision !== projection.evidenceRevision,
    },
  };
}
