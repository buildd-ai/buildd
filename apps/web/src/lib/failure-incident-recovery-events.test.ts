import { describe, it, expect } from 'bun:test';
import type { FailureIncidentRecovery } from '@buildd/shared';
import { attemptNumberOf, buildAttemptEvent, repairKindOf, verifyPriorAttempt } from './failure-incident-recovery-events';

const KEY = 'recovery:inc-1:task:t1:path_overlap.blocker_merged_unreleased:release_blocker:g1:a1';

function rec(over: Partial<FailureIncidentRecovery> = {}): FailureIncidentRecovery {
  return {
    v: 1, generation: 1,
    cause: { reasonCode: 'path_overlap.blocker_merged_unreleased', rule: 'path_overlap_stall', ownership: 'workflow' },
    subjects: [{ kind: 'task', id: 't1' }], blockers: [], overlappingPaths: [],
    observation: { observedAt: '2026-10-11T10:00:00.000Z', source: 'sweep', evidenceRevision: 'rev-1' },
    firstSeenAt: '2026-10-11T08:00:00.000Z', lastSeenAt: '2026-10-11T10:00:00.000Z', lastProgressAt: null,
    owner: 'buildd', state: 'recovering', nextAction: { kind: 'release_blocker', label: 'Release', key: KEY },
    nextCheckAt: '2026-10-11T10:02:00.000Z',
    verification: { predicate: 'path_overlap.subjects_progressed', params: {} },
    budget: { spent: 1, limit: 3, deadlineAt: '2026-10-11T14:00:00.000Z', spentKeys: [KEY] },
    attempts: [{ key: KEY, action: 'release_blocker', subject: { kind: 'task', id: 't1' }, at: '2026-10-11T10:00:00.000Z', generation: 1 }],
    causeGroup: { key: 'c1:0123456789abcdef0123', source: 'rule', decisionId: null, confidence: null, assignedAt: '2026-10-11T10:00:00.000Z' },
    ...over,
  };
}

describe('attempt events', () => {
  it('names capabilities by RepairKind', () => {
    expect(repairKindOf('file_fix_task')).toBe('queue_fix');
    expect(repairKindOf('release_blocker')).toBe('release_blocker');
    expect(attemptNumberOf(KEY)).toBe(1);
  });

  it('carries the fixed detail shape, verify unknown until re-checked', () => {
    const e = buildAttemptEvent({
      incident: { id: 'inc-1', workspaceId: 'ws-1' }, recovery: rec(),
      repair: { key: KEY, action: 'release_blocker', subject: { kind: 'task', id: 't1' } }, source: 'sweep', ok: true,
    });
    expect(e.outcome).toBe('accepted');
    expect(Object.keys(e.detail).sort()).toEqual(['actionKey', 'actor', 'attempt', 'capability', 'causeKey', 'costUsd', 'generation', 'incidentId', 'subject', 'verify']);
    expect(e.detail.verify).toEqual({ predicate: 'path_overlap.subjects_progressed', passed: null, evidenceRevision: 'rev-1' });
    expect(e.detail.causeKey).toBe('c1:0123456789abcdef0123');
    expect(e.detail.actor).toBe('buildd:sweep');
  });

  it('a repair that threw is a rejected (failed) attempt', () => {
    const e = buildAttemptEvent({ incident: { id: 'inc-1', workspaceId: null }, recovery: rec(), repair: { key: KEY, action: 'wake_subject', subject: { kind: 'task', id: 't1' } }, source: 'backstop', ok: false });
    expect(e.outcome).toBe('rejected');
  });
});

describe('verifyPriorAttempt', () => {
  it('passes when the incident recovered on the re-check', () => {
    const v = verifyPriorAttempt(rec(), rec({ state: 'recovered', nextAction: null, observation: { observedAt: '2026-10-11T10:05:00.000Z', source: 'sweep', evidenceRevision: 'rev-2' } }));
    expect(v).toEqual({ actionKey: KEY, passed: true, predicate: 'path_overlap.subjects_progressed', evidenceRevision: 'rev-2' });
  });

  it('passes on real progress after the attempt, not on the writer returning', () => {
    expect(verifyPriorAttempt(rec(), rec({ state: 'waiting', nextAction: { kind: 'wait', label: 'w', key: 'g' }, lastProgressAt: '2026-10-11T10:01:00.000Z' }))?.passed).toBe(true);
    expect(verifyPriorAttempt(rec(), rec({ state: 'waiting', nextAction: { kind: 'wait', label: 'w', key: 'g' }, lastProgressAt: '2026-10-11T09:00:00.000Z' }))?.passed).toBe(false);
  });

  it('records nothing while the repair is in flight, or when the re-check could not read the facts', () => {
    expect(verifyPriorAttempt(rec(), rec())).toBeNull();
    expect(verifyPriorAttempt(rec(), rec({ state: 'inconclusive', nextAction: { kind: 'recheck', label: 'r', key: 'g' } }))).toBeNull();
  });

  it('records nothing when the prior assessment ran no repair', () => {
    expect(verifyPriorAttempt(rec({ state: 'waiting' }), rec({ state: 'recovered' }))).toBeNull();
    expect(verifyPriorAttempt(null, rec({ state: 'recovered' }))).toBeNull();
  });
});
