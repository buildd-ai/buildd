import { describe, it, expect } from 'bun:test';
import {
  CLAIM_HOLD_STRANDED_AFTER_MS,
  labelClaimHoldDecisions,
  summarizeClaimHoldReadout,
  type ClaimDecisionForReadout,
  type ClaimHoldReadoutInput,
} from '../orchestration-claim-readout';
import type { DecisionOutcomeLabels } from '../orchestration-outcomes';

/**
 * Hold/start readout (§5b, §6). The point of these tests: a held task can
 * never count as a safe start, and HOLD-everything cannot look good because
 * wait time, stranded rate and throughput sit next to the unsafe-start rate.
 */

const T0 = new Date('2026-09-30T12:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const decision = (over: Partial<ClaimDecisionForReadout> = {}): ClaimDecisionForReadout => ({
  id: 'd1',
  taskId: 'task-1',
  workspaceId: 'ws',
  decisionId: 'buildd.orchestration_claim_hold',
  fingerprint: 'f'.repeat(12),
  candidatePolicyVersion: 'ch1.open_pr_overlap',
  model: 'typesafe/jev-1',
  experimentArm: 'observe',
  propensity: 1,
  applied: false,
  effective: 'HOLD',
  suggested: 'START',
  status: 'suggested',
  reason: 'shadow',
  createdAt: T0,
  ...over,
});

const observed = (decisionId: string, risk: boolean, parts: { conflict?: boolean; collision?: boolean; refusal?: boolean } = {}): DecisionOutcomeLabels => ({
  decisionId,
  task: { status: 'observed', value: 'completed' },
  touched: { status: 'observed', value: { paths: ['a.ts'], landed: true, failed: false, truncated: false } },
  conflictCreated: { status: 'observed', value: parts.conflict ?? false, count: parts.conflict ? 1 : 0, joinKey: 'pr' },
  collision: { status: 'observed', value: parts.collision ?? false, count: parts.collision ? 1 : 0 },
  mergeBaseRefusal: { status: 'observed', value: parts.refusal ?? false, count: parts.refusal ? 1 : 0, joinKey: 'pr' },
  risk: { status: 'observed', value: risk },
});

const input = (over: Partial<ClaimHoldReadoutInput> = {}): ClaimHoldReadoutInput => ({
  decisions: [decision()],
  labels: [observed('d1', false)],
  tasks: [{ id: 'task-1', status: 'completed' }],
  starts: [{ taskId: 'task-1', startedAt: at(30) }],
  windowEnd: at(60 * 48),
  ...over,
});

describe('labelClaimHoldDecisions: censoring', () => {
  it('a shadow (held) decision is censored as held_by_rule even when its later run was clean', () => {
    const [l] = labelClaimHoldDecisions(input());
    expect(l.startedAtDecision).toBe(false);
    expect(l.startSafety).toEqual({ status: 'censored', reason: 'held_by_rule' });
    expect(l.conflictCreated).toEqual({ status: 'censored', reason: 'held_by_rule' });
    expect(l.collision).toEqual({ status: 'censored', reason: 'held_by_rule' });
    expect(l.mergeBaseRefusal).toEqual({ status: 'censored', reason: 'held_by_rule' });
  });

  it('a shadow START suggestion is still censored: shadow cannot label a never-started task safe', () => {
    const [l] = labelClaimHoldDecisions(input({ decisions: [decision({ suggested: 'START', status: 'suggested' })] }));
    expect(l.startSafety.status).toBe('censored');
  });

  it('an applied START uses the observed outcome labels, separately and as a composite', () => {
    const [l] = labelClaimHoldDecisions(input({
      decisions: [decision({ applied: true, effective: 'START', status: 'applied', reason: null, experimentArm: 'apply', propensity: 0.1 })],
      labels: [observed('d1', true, { collision: true })],
    }));
    expect(l.startedAtDecision).toBe(true);
    expect(l.startSafety).toEqual({ status: 'observed', value: true });
    expect(l.collision).toEqual({ status: 'observed', value: true });
    expect(l.conflictCreated).toEqual({ status: 'observed', value: false });
    expect(l.mergeBaseRefusal).toEqual({ status: 'observed', value: false });
  });

  it('an applied START with no outcome label yet is missing, never safe', () => {
    const [l] = labelClaimHoldDecisions(input({
      decisions: [decision({ applied: true, effective: 'START', status: 'applied', experimentArm: 'apply' })],
      labels: [],
    }));
    expect(l.startSafety).toEqual({ status: 'missing', reason: 'no_label' });
  });

  it('an applied START on a task later cancelled stays censored (F labels it cancelled)', () => {
    const cancelled: DecisionOutcomeLabels = {
      decisionId: 'd1',
      task: { status: 'censored', reason: 'cancelled' },
      touched: { status: 'censored', reason: 'cancelled' },
      conflictCreated: { status: 'censored', reason: 'cancelled' },
      collision: { status: 'censored', reason: 'cancelled' },
      mergeBaseRefusal: { status: 'censored', reason: 'cancelled' },
      risk: { status: 'censored', reason: 'cancelled' },
    };
    const [l] = labelClaimHoldDecisions(input({
      decisions: [decision({ applied: true, effective: 'START', status: 'applied', experimentArm: 'apply' })],
      labels: [cancelled],
    }));
    expect(l.startSafety).toEqual({ status: 'censored', reason: 'cancelled' });
  });
});

describe('summarizeClaimHoldReadout: wait, stranded, throughput', () => {
  it('reports wait time from the first decision to the first start', () => {
    const [g] = summarizeClaimHoldReadout(input());
    expect(g.wait.n).toBe(1);
    expect(g.wait.p50Ms).toBe(30 * 60_000);
    expect(g.throughput.starts).toBe(1);
    expect(g.stranded).toEqual({ stranded: 0, resolved: 1, censored: 0, rate: 0 });
  });

  it('a start before the decision does not count as this decision\'s start', () => {
    const [g] = summarizeClaimHoldReadout(input({ starts: [{ taskId: 'task-1', startedAt: at(-5) }] }));
    expect(g.wait.n).toBe(0);
    expect(g.throughput.starts).toBe(0);
  });

  it('a task cancelled while held, never started, is stranded', () => {
    const [g] = summarizeClaimHoldReadout(input({
      tasks: [{ id: 'task-1', status: 'cancelled' }], starts: [], labels: [],
    }));
    expect(g.stranded.stranded).toBe(1);
    expect(g.stranded.rate).toBe(1);
  });

  it('a task still pending past the stranded threshold is stranded; inside it, censored', () => {
    const past = summarizeClaimHoldReadout(input({ tasks: [{ id: 'task-1', status: 'pending' }], starts: [], labels: [] }))[0];
    expect(past.stranded.stranded).toBe(1);
    const inside = summarizeClaimHoldReadout(input({
      tasks: [{ id: 'task-1', status: 'pending' }], starts: [], labels: [],
      windowEnd: new Date(T0.getTime() + CLAIM_HOLD_STRANDED_AFTER_MS - 1),
    }))[0];
    expect(inside.stranded).toEqual({ stranded: 0, resolved: 0, censored: 1, rate: null });
  });

  it('HOLD-everything cannot look good: no unsafe starts, but no observed safe ones either, and the wait shows', () => {
    const decisions = [1, 2, 3].map(i => decision({ id: `d${i}`, taskId: `task-${i}`, suggested: 'HOLD' }));
    const [g] = summarizeClaimHoldReadout(input({
      decisions,
      labels: decisions.map(d => observed(d.id, false)),
      tasks: decisions.map(d => ({ id: d.taskId!, status: 'pending' })),
      starts: [],
    }));
    expect(g.startSafety.observedSafe).toBe(0);
    expect(g.startSafety.observedUnsafe).toBe(0);
    expect(g.unsafeStartRate).toBeNull();
    expect(g.startSafety.censored).toBe(3);
    expect(g.censoredShare).toBe(1);
    expect(g.stranded.rate).toBe(1);
    expect(g.throughput.starts).toBe(0);
  });

  it('groups by decision, fingerprint, candidate policy, model and arm, with the propensity kept', () => {
    const groups = summarizeClaimHoldReadout(input({
      decisions: [
        decision({ id: 'd1', taskId: 'task-1' }),
        decision({ id: 'd2', taskId: 'task-2', experimentArm: 'apply', propensity: 0.2, applied: true, effective: 'START', status: 'applied' }),
        decision({ id: 'd3', taskId: 'task-3', candidatePolicyVersion: 'ch1.advisory_manifest' }),
      ],
      labels: [observed('d1', false), observed('d2', true, { conflict: true }), observed('d3', false)],
      tasks: [{ id: 'task-1', status: 'completed' }, { id: 'task-2', status: 'completed' }, { id: 'task-3', status: 'completed' }],
      starts: [{ taskId: 'task-2', startedAt: at(0) }],
    }));
    expect(groups).toHaveLength(3);
    const apply = groups.find(g => g.experimentArm === 'apply')!;
    expect(apply.appliedStarts).toBe(1);
    expect(apply.unsafeStartRate).toBe(1);
    expect(apply.separate.conflictCreated).toBe(1);
    expect(apply.meanPropensity).toBe(0.2);
    expect(groups.find(g => g.candidatePolicyVersion === 'ch1.advisory_manifest')!.decisions).toBe(1);
  });

  it('counts each task once for wait and stranded when it was asked about repeatedly', () => {
    const [g] = summarizeClaimHoldReadout(input({
      decisions: [decision({ id: 'd1' }), decision({ id: 'd2', createdAt: at(10) })],
      labels: [observed('d1', false), observed('d2', false)],
    }));
    expect(g.decisions).toBe(2);
    expect(g.tasks).toBe(1);
    expect(g.wait.n).toBe(1);
    expect(g.wait.p50Ms).toBe(30 * 60_000);
  });

  it('a fallback decision (no answer) is counted, with no suggestion', () => {
    const [g] = summarizeClaimHoldReadout(input({ decisions: [decision({ suggested: null, status: 'fallback', reason: 'deadline' })] }));
    expect(g.suggestions).toEqual({ HOLD: 0, START: 0, none: 1 });
  });
});
