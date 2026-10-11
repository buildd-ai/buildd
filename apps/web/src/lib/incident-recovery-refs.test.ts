import { describe, it, expect } from 'bun:test';
import type { FailureIncidentRecovery } from '@buildd/shared';
import { readIncidentRecoveryRef, taskRecoveryView, INCIDENT_RECOVERY_CONTEXT_KEY } from './incident-recovery-refs';
import type { IncidentForView } from './incident-view';

const NOW = '2026-10-11T14:00:00.000Z';

function recovery(over: Partial<FailureIncidentRecovery> = {}): FailureIncidentRecovery {
  return {
    v: 1, generation: 2,
    cause: { reasonCode: 'infrastructure_failure.visual_qa.scrub', rule: 'path_overlap_stall', ownership: 'infrastructure' },
    subjects: [{ kind: 'task', id: 't1' }, { kind: 'mission', id: 'm1' }], blockers: [], overlappingPaths: [],
    observation: { observedAt: '2026-10-11T13:58:00.000Z', source: 'sweep', evidenceRevision: 'r' },
    firstSeenAt: '2026-10-11T12:00:00.000Z', lastSeenAt: NOW, lastProgressAt: null, owner: 'buildd', state: 'recovering',
    nextAction: { kind: 'fix_task_running', label: 'Buildd is repairing the screenshot database scrub (task f1aaaaaa).', key: 'fix:f1' },
    nextCheckAt: '2026-10-11T14:15:00.000Z',
    verification: { predicate: 'p', params: {} }, budget: { spent: 0, limit: 3, deadlineAt: NOW, spentKeys: [] }, attempts: [],
    ...over,
  };
}
const incident = (over: Partial<IncidentForView> = {}): IncidentForView => ({
  id: 'i1', status: 'open', severity: 'high', rule: 'path_overlap_stall', linkedFixTaskId: 'f1',
  firstSeenAt: NOW, lastSeenAt: NOW, recovery: recovery(), ...over,
});

describe('the task adapter reads the incident, never the question text (§16.4, §17.2)', () => {
  it('reads the ref from its own context key, not the runner\'s checkpoint recoveryRef string', () => {
    expect(INCIDENT_RECOVERY_CONTEXT_KEY).toBe('incidentRecovery');
    expect(readIncidentRecoveryRef({ incidentRecovery: { incidentId: 'i1', generation: 2 } })).toEqual({ incidentId: 'i1', generation: 2 });
    expect(readIncidentRecoveryRef({ recoveryRef: 'origin/buildd/x@abc' })).toBeNull();
    expect(readIncidentRecoveryRef({ incidentRecovery: { incidentId: 5 } })).toBeNull();
    expect(readIncidentRecoveryRef(null)).toBeNull();
  });

  it('repairing: a concise factual status owned by Buildd, and it supersedes a stale question', () => {
    const v = taskRecoveryView(incident(), { now: NOW, timeZone: 'UTC' })!;
    expect(v).toMatchObject({ phase: 'repair_running', stateWord: 'Repair running', ownerLabel: 'Buildd', supersedesQuestion: true, holdsCompletion: true, href: '/app/incidents/i1' });
    expect(v.sentence).toMatch(/^Buildd is repairing/);
  });

  it('retry exhausted (operator): the gap is shown, still no question for the person', () => {
    const v = taskRecoveryView(incident({ recovery: recovery({ state: 'needs_operator', owner: 'operator', capabilityGap: { capability: 'repair_infrastructure:visual_qa.scrub', reason: 'the scrub keeps failing' } }) }), { now: NOW })!;
    expect(v).toMatchObject({ phase: 'unavailable', ownerLabel: 'Operator', supersedesQuestion: true, holdsCompletion: true });
  });

  it('a genuine decision does not supersede: the person\'s question stays', () => {
    const v = taskRecoveryView(incident({ recovery: recovery({ state: 'needs_decision', owner: 'person', nextCheckAt: null, decision: { question: 'Waive this audit?', options: [], recommended: 'dismiss' } }) }), { now: NOW })!;
    expect(v.supersedesQuestion).toBe(false);
  });

  it('recovered: nothing left to say on the task, and completion is no longer held', () => {
    const v = taskRecoveryView(incident({ status: 'resolved', recovery: recovery({ state: 'recovered', nextAction: null, nextCheckAt: null }) }), { now: NOW })!;
    expect(v).toMatchObject({ phase: 'recovered', supersedesQuestion: true, holdsCompletion: false });
  });

  it('no incident row: no view (unknown stays explicit; the question is left alone)', () => {
    expect(taskRecoveryView(null, { now: NOW })).toBeNull();
  });
});
