/**
 * One outcome vocabulary for every start past a hold (coordination-visibility-map
 * §8.1): a person's Force start is graded with the same labels as a Jev START,
 * but never scored as a policy result.
 */
import { describe, it, expect } from 'bun:test';
import { gradeStart, startActorOf, HUMAN_FORCE_START_DECISION_ID, type DecisionOutcomeLabels } from '../orchestration-outcomes';

const observed = (over: Partial<DecisionOutcomeLabels> = {}): DecisionOutcomeLabels => ({
  decisionId: 'd1',
  task: { status: 'observed', value: 'completed' },
  touched: { status: 'observed', value: { paths: ['a.ts'], landed: true, failed: false, truncated: false } },
  conflictCreated: { status: 'observed', value: false, count: 0, joinKey: 'pr' },
  collision: { status: 'observed', value: false, count: 0 },
  mergeBaseRefusal: { status: 'observed', value: false, count: 0, joinKey: 'pr' },
  risk: { status: 'observed', value: false },
  ...over,
});

describe('gradeStart', () => {
  it('a human force row is graded but never scored', () => {
    expect(startActorOf({ decisionId: HUMAN_FORCE_START_DECISION_ID, experimentArm: 'human', effective: 'START', applied: true })).toBe('human_force');
    expect(startActorOf({ decisionId: 'buildd.claim_hold', experimentArm: 'apply', effective: 'START', applied: true })).toBe('jev_start');
    expect(startActorOf({ decisionId: 'buildd.claim_hold', experimentArm: 'apply', effective: 'HOLD', applied: true })).toBeNull();
    const g = gradeStart(observed(), 'human_force', { waitAvoidedMs: 60_000 });
    expect(g).toMatchObject({ outcome: 'clean', actor: 'human_force', scored: false, waitAvoidedMs: 60_000 });
    expect(gradeStart(observed(), 'jev_start').scored).toBe(true);
  });

  it('names the first unsafe dimension in the shared vocabulary', () => {
    expect(gradeStart(observed({ collision: { status: 'observed', value: true, count: 2 }, risk: { status: 'observed', value: true } }), 'human_force').outcome).toBe('edit_collision');
    const conflict = gradeStart(observed({ conflictCreated: { status: 'observed', value: true, count: 1, joinKey: 'pr' }, risk: { status: 'observed', value: true } }), 'human_force');
    expect(conflict.outcome).toBe('merge_conflict');
    expect(conflict.dims.repairTask).toEqual({ status: 'observed', value: true });
    expect(gradeStart(observed({ mergeBaseRefusal: { status: 'observed', value: true, count: 1, joinKey: 'pr' }, risk: { status: 'observed', value: true } }), 'jev_start').outcome).toBe('base_refusal');
  });

  it('an open window is censored, never clean; rollback has no source and stays missing', () => {
    const open = gradeStart(observed({ risk: { status: 'censored', reason: 'pr_open' }, conflictCreated: { status: 'censored', reason: 'pr_open' } }), 'human_force');
    expect(open.outcome).toBe('censored');
    expect(open.dims.rollback).toEqual({ status: 'missing' });
  });
});
