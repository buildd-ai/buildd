import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_FINDING_ACTION_POLICY,
  MAX_LEDGER_AFFECTED_REFS,
  MAX_LEDGER_EVIDENCE_REFS,
  aggregateFindingOccurrence,
  buildCorrectionProposal,
  buildFollowUpTask,
  decideFindingAction,
  findingActionTarget,
  recentOccurrences,
  resolveFindingActionPolicy,
  type FindingLedgerAggregate,
  type FindingOccurrence,
} from '../post-session-findings';

const NOW = new Date('2026-10-04T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const policy = DEFAULT_FINDING_ACTION_POLICY;

function occ(over: Partial<FindingOccurrence['finding']> = {}, ref: Partial<FindingOccurrence['ref']> = {}): FindingOccurrence {
  return {
    finding: {
      class: 'platform',
      severity: 'medium',
      confidence: 0.6,
      title: 'Review or CI needed a fix loop to converge',
      summary: 'Review and CI converge without a fix loop. Observed: ciFixAttempts=3.',
      signature: 'sig-1',
      recurrenceKey: 'post_session:platform:review_converges',
      proposedAction: 'file_task',
      evidenceRefs: [{ kind: 'post_session_run', ref: ref.runId ?? 'run-1' }],
      ...over,
    },
    ref: { runId: 'run-1', workerId: 'worker-1', taskId: 'task-1', seenAt: NOW.toISOString(), ...ref },
  };
}

function aggregateOf(...occs: FindingOccurrence[]): FindingLedgerAggregate {
  let agg: FindingLedgerAggregate | null = null;
  for (const o of occs) agg = aggregateFindingOccurrence(agg, o).next;
  return agg!;
}

describe('resolveFindingActionPolicy', () => {
  it('defaults to confidence 0.7 and medium promotion at 2 occurrences in 7 days', () => {
    expect(resolveFindingActionPolicy(null)).toEqual({
      highConfidenceThreshold: 0.7,
      mediumRecurrence: { count: 2, windowDays: 7 },
    });
  });

  it('reads overrides from the workspace config', () => {
    const p = resolveFindingActionPolicy({ postSessionQuality: { findingPolicy: { highConfidenceThreshold: 0.9, mediumRecurrence: { count: 3, windowDays: 14 } } } });
    expect(p).toEqual({ highConfidenceThreshold: 0.9, mediumRecurrence: { count: 3, windowDays: 14 } });
  });

  it('ignores out-of-range or malformed values field by field', () => {
    const p = resolveFindingActionPolicy({ postSessionQuality: { findingPolicy: { highConfidenceThreshold: 4, mediumRecurrence: { count: 0, windowDays: 'x' as any } } } });
    expect(p).toEqual(DEFAULT_FINDING_ACTION_POLICY);
  });

  it('caps the recurrence count at what the ledger can count', () => {
    const p = resolveFindingActionPolicy({ postSessionQuality: { findingPolicy: { mediumRecurrence: { count: 500 } } } });
    expect(p.mediumRecurrence.count).toBe(DEFAULT_FINDING_ACTION_POLICY.mediumRecurrence.count);
  });
});

describe('aggregateFindingOccurrence', () => {
  it('creates a first-seen aggregate from one occurrence', () => {
    const { next, counted } = aggregateFindingOccurrence(null, occ());
    expect(counted).toBe(true);
    expect(next.occurrenceCount).toBe(1);
    expect(next.firstSeenAt).toEqual(NOW);
    expect(next.lastSeenAt).toEqual(NOW);
    expect(next.affectedRefs).toHaveLength(1);
  });

  it('is idempotent per run: reprocessing the same incident does not count twice', () => {
    const first = aggregateFindingOccurrence(null, occ()).next;
    const again = aggregateFindingOccurrence(first, occ());
    expect(again.counted).toBe(false);
    expect(again.next).toEqual(first);
  });

  it('aggregates a second run: count, last seen, affected refs, highest severity and confidence', () => {
    const later = new Date(NOW.getTime() + DAY);
    const agg = aggregateOf(
      occ(),
      occ({ severity: 'high', confidence: 0.9, title: 'worse' }, { runId: 'run-2', workerId: 'worker-2', taskId: 'task-2', seenAt: later.toISOString() }),
    );
    expect(agg.occurrenceCount).toBe(2);
    expect(agg.firstSeenAt).toEqual(NOW);
    expect(agg.lastSeenAt).toEqual(later);
    expect(agg.severity).toBe('high');
    expect(agg.confidence).toBe(0.9);
    // The headline follows the most severe occurrence.
    expect(agg.title).toBe('worse');
    expect(agg.affectedRefs.map(r => r.runId)).toEqual(['run-1', 'run-2']);
    expect(agg.evidenceRefs.map(r => r.ref)).toContain('run-2');
  });

  it('never lowers severity or confidence', () => {
    const agg = aggregateOf(
      occ({ severity: 'critical', confidence: 0.95, title: 'bad' }),
      occ({ severity: 'low', confidence: 0.1, title: 'meh' }, { runId: 'run-2' }),
    );
    expect(agg.severity).toBe('critical');
    expect(agg.confidence).toBe(0.95);
    expect(agg.title).toBe('bad');
  });

  it('caps affected refs at the newest N while the count stays exact', () => {
    const occs = Array.from({ length: MAX_LEDGER_AFFECTED_REFS + 5 }, (_, i) =>
      occ({}, { runId: `run-${i}`, seenAt: new Date(NOW.getTime() + i * 1000).toISOString() }));
    const agg = aggregateOf(...occs);
    expect(agg.occurrenceCount).toBe(MAX_LEDGER_AFFECTED_REFS + 5);
    expect(agg.affectedRefs).toHaveLength(MAX_LEDGER_AFFECTED_REFS);
    expect(agg.affectedRefs[0].runId).toBe('run-5');
  });

  it('dedupes and caps evidence refs', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'k', ref: `r${i}` }));
    const agg = aggregateOf(occ({ evidenceRefs: many }), occ({ evidenceRefs: many }, { runId: 'run-2' }));
    expect(agg.evidenceRefs.length).toBe(MAX_LEDGER_EVIDENCE_REFS);
    expect(new Set(agg.evidenceRefs.map(r => r.ref)).size).toBe(agg.evidenceRefs.length);
  });
});

describe('recentOccurrences', () => {
  it('counts affected sessions inside the window only', () => {
    const agg = aggregateOf(
      occ({}, { runId: 'old', seenAt: new Date(NOW.getTime() - 10 * DAY).toISOString() }),
      occ({}, { runId: 'new', seenAt: NOW.toISOString() }),
    );
    expect(recentOccurrences(agg, 7, NOW)).toBe(1);
    expect(recentOccurrences(agg, 30, NOW)).toBe(2);
  });
});

describe('decideFindingAction', () => {
  const base = { policy, now: NOW, actionState: 'observed' as const, counted: true };

  it('critical: act immediately and warn', () => {
    const d = decideFindingAction(aggregateOf(occ({ severity: 'critical', confidence: 0.2 })), base);
    expect(d).toMatchObject({ act: true, target: 'task', reason: 'critical', warn: true });
  });

  it('high: act only when confidence clears the threshold', () => {
    expect(decideFindingAction(aggregateOf(occ({ severity: 'high', confidence: 0.7 })), base))
      .toMatchObject({ act: true, reason: 'high_confident', warn: false });
    expect(decideFindingAction(aggregateOf(occ({ severity: 'high', confidence: 0.69 })), base))
      .toMatchObject({ act: false, reason: 'high_below_threshold' });
  });

  it('medium: observe once, promote on the second occurrence inside the window', () => {
    const one = aggregateOf(occ());
    expect(decideFindingAction(one, base)).toMatchObject({ act: false, reason: 'medium_observing' });
    const two = aggregateOf(occ(), occ({}, { runId: 'run-2' }));
    expect(decideFindingAction(two, base)).toMatchObject({ act: true, reason: 'medium_recurred' });
  });

  it('medium: two occurrences further apart than the window do not promote', () => {
    const two = aggregateOf(
      occ({}, { runId: 'old', seenAt: new Date(NOW.getTime() - 8 * DAY).toISOString() }),
      occ({}, { runId: 'new' }),
    );
    expect(decideFindingAction(two, base)).toMatchObject({ act: false, reason: 'medium_observing' });
  });

  it('low and no_action: aggregate only', () => {
    expect(decideFindingAction(aggregateOf(occ({ severity: 'low', confidence: 1 })), base))
      .toMatchObject({ act: false, reason: 'low_aggregate_only' });
    expect(decideFindingAction(aggregateOf(occ({ class: 'no_action', severity: 'low' })), base))
      .toMatchObject({ act: false, reason: 'no_action' });
  });

  it('an already-actioned finding is not acted on again', () => {
    for (const actionState of ['task_filed', 'proposal_filed', 'suppressed'] as const) {
      expect(decideFindingAction(aggregateOf(occ({ severity: 'critical' })), { ...base, actionState }))
        .toMatchObject({ act: false, reason: 'already_actioned' });
    }
  });

  it('a new critical occurrence on a filed task asks for the task to be updated', () => {
    const agg = aggregateOf(occ({ severity: 'critical' }), occ({ severity: 'critical' }, { runId: 'run-2' }));
    expect(decideFindingAction(agg, { ...base, actionState: 'task_filed', counted: true }))
      .toMatchObject({ act: false, reason: 'already_actioned', appendToTask: true });
    expect(decideFindingAction(agg, { ...base, actionState: 'task_filed', counted: false }))
      .toMatchObject({ appendToTask: false });
  });

  it('a promoted (shadow-mode) finding is still eligible to file', () => {
    expect(decideFindingAction(aggregateOf(occ({ severity: 'critical' })), { ...base, actionState: 'promoted' }))
      .toMatchObject({ act: true });
  });
});

describe('findingActionTarget', () => {
  it('routes knowledge defects to a correction proposal, never a task', () => {
    expect(findingActionTarget({ class: 'knowledge', proposedAction: 'file_task' })).toBe('proposal');
    expect(findingActionTarget({ class: 'platform', proposedAction: 'propose_memory_correction' })).toBe('proposal');
    expect(findingActionTarget({ class: 'platform', proposedAction: 'file_task' })).toBe('task');
  });
});

describe('buildFollowUpTask', () => {
  it('carries the ledger identity in context and points at evidence', () => {
    const agg = aggregateOf(occ({ severity: 'critical' }), occ({ severity: 'critical' }, { runId: 'run-2', taskId: 'task-2' }));
    const t = buildFollowUpTask({ findingId: 'f-1', signature: 'sig-1', policyVersion: 'psq-v1', aggregate: agg });
    expect(t.title.startsWith('[post-session] ')).toBe(true);
    expect(t.context).toEqual({
      postSessionFinding: { findingId: 'f-1', signature: 'sig-1', policyVersion: 'psq-v1', class: 'platform', severity: 'critical' },
    });
    expect(t.description).toContain('run-2');
    expect(t.description).toContain('task-2');
    expect(t.description).toContain('Occurrences: 2');
    expect(t.priority).toBeGreaterThan(buildFollowUpTask({ findingId: 'f', signature: 's', policyVersion: 'p', aggregate: aggregateOf(occ()) }).priority);
  });
});

describe('buildCorrectionProposal', () => {
  it('is an auditable proposal naming the memory, the contradicting evidence and the sessions', () => {
    const agg = aggregateOf(occ({
      class: 'knowledge',
      severity: 'high',
      proposedAction: 'propose_memory_correction',
      title: 'Retrieved knowledge contradicts shipped state',
      evidenceRefs: [
        { kind: 'post_session_run', ref: 'run-1' },
        { kind: 'memory', ref: 'mem-42' },
        { kind: 'pr', ref: '1234' },
      ],
    }));
    const p = buildCorrectionProposal({ findingId: 'f-1', signature: 'sig-1', policyVersion: 'psq-v1', aggregate: agg });
    expect(p.key).toBe('post-session-correction:psq-v1:sig-1');
    expect(p.type).toBe('recommendation');
    expect(p.metadata).toMatchObject({
      kind: 'memory_correction_proposal',
      status: 'proposed',
      findingId: 'f-1',
      memorySourceIds: ['mem-42'],
      contradictingEvidence: [{ kind: 'pr', ref: '1234' }],
      sessions: [{ runId: 'run-1', workerId: 'worker-1', taskId: 'task-1' }],
      appliedAt: null,
    });
    expect(p.content).toContain('mem-42');
    expect(p.content).toContain('supersede');
    expect(p.content.toLowerCase()).toContain('not been applied');
  });
});
