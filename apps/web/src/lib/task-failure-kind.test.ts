import { describe, expect, it } from 'bun:test';
import { classifyTaskFailure, classifyTaskTrouble, verificationFailedCopy } from './task-failure-kind';

const merged = { status: 'completed', prUrl: 'https://github.com/o/r/pull/1', mergedAt: '2026-01-01', prLifecycleStatus: 'merged' };
const died = { status: 'failed', prUrl: null, mergedAt: null, prLifecycleStatus: null };

describe('classifyTaskFailure', () => {
  it('is null for a task that did not fail', () => {
    expect(classifyTaskFailure({ id: 'a', title: 'Build', status: 'completed', workers: [merged] }, [])).toBeNull();
  });
  it('a worker that died is an execution failure', () => {
    expect(classifyTaskFailure({ id: 'a', title: 'Build', status: 'failed', workers: [died] }, [])).toBe('execution');
  });
  it('landed implementation + a failed audit sibling is a verification failure', () => {
    const audit = { id: 'b', title: '[surface audit] Mission', status: 'failed' };
    expect(classifyTaskFailure({ id: 'a', title: 'Build', status: 'failed', workers: [merged] }, [audit])).toBe('verification');
  });
  it('a failed audit whose own worker finished and reported is verification', () => {
    const impl = { id: 'a', title: 'Build', status: 'completed', workers: [merged] };
    const reported = { status: 'completed', prUrl: null, mergedAt: null, prLifecycleStatus: null };
    expect(classifyTaskFailure({ id: 'b', title: '[surface audit] Mission', status: 'failed', workers: [reported] }, [impl])).toBe('verification');
  });
  it('a failed audit whose worker died is execution even with an implementation landed', () => {
    const impl = { id: 'a', title: 'Build', status: 'completed', workers: [merged] };
    expect(classifyTaskFailure({ id: 'b', title: '[surface audit] Mission', status: 'failed', workers: [died] }, [impl])).toBe('execution');
    expect(classifyTaskFailure({ id: 'b', title: '[surface audit] Mission', status: 'failed', workers: [] }, [impl])).toBe('execution');
  });
  it('a failed audit with nothing landed is an execution failure', () => {
    expect(classifyTaskFailure({ id: 'b', title: '[surface audit] Mission', status: 'failed', workers: [died] }, [])).toBe('execution');
  });
  it('a worker that died stays execution even if an audit failed', () => {
    const audit = { id: 'b', title: '[surface audit] Mission', status: 'failed' };
    expect(classifyTaskFailure({ id: 'a', title: 'Build', status: 'failed', workers: [died] }, [audit])).toBe('execution');
  });
});

describe('verificationFailedCopy', () => {
  it('is a state and a cause, each one short phrase, never repeating', () => {
    const c = verificationFailedCopy();
    expect(c.state).toBe('Implementation complete, verification failed');
    expect(c.cause.length).toBeLessThan(60);
    expect(c.cause.toLowerCase()).not.toContain('verification failed');
  });
});

describe('classifyTaskTrouble (R-20: waiting, buildd retrying, or a person acts)', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const later = '2026-10-22T13:00:00.000Z';
  const blocker = (status: string, workers: any[] = []) => ({ id: 'b', title: 'Runner image', status, workers });
  const pending = (over: Record<string, unknown> = {}) => ({ id: 'a', title: 'Build', status: 'pending', dependsOn: ['b'], ...over });

  it('a pending task whose dependency is open waits on it, by name', () => {
    expect(classifyTaskTrouble(pending(), [blocker('in_progress')], now)).toEqual({ kind: 'waiting', on: { taskId: 'b', title: 'Runner image' } });
  });
  it('a dependency completed with its PR still open still holds it', () => {
    const open = { status: 'completed', prUrl: 'https://github.com/o/r/pull/2', mergedAt: null, prLifecycleStatus: 'open' };
    expect(classifyTaskTrouble(pending(), [blocker('completed', [open])], now)?.kind).toBe('waiting');
  });
  it('a merged dependency holds nothing', () => {
    expect(classifyTaskTrouble(pending(), [blocker('completed', [merged])], now)).toBeNull();
  });
  it('safety net: a blocker that was cancelled or failed needs a person', () => {
    expect(classifyTaskTrouble(pending(), [blocker('cancelled')], now)).toEqual({ kind: 'needs_person', cause: 'blocker_cancelled', on: { taskId: 'b', title: 'Runner image' } });
    expect(classifyTaskTrouble(pending(), [blocker('failed')], now)?.kind).toBe('needs_person');
  });
  it('a task the cascade failed (dependency) reads as waiting, not failed', () => {
    const t = { id: 'a', title: 'Build', status: 'failed', workers: [], result: { errorType: 'dependency_failed', blockedBy: { taskId: 'b', title: 'Runner image' } } };
    expect(classifyTaskTrouble(t, [blocker('failed')], now)).toEqual({ kind: 'waiting', on: { taskId: 'b', title: 'Runner image' } });
  });
  it('infra backoff and a provider pause are buildd retrying, with the resume time', () => {
    expect(classifyTaskTrouble(pending({ dependsOn: [], startAt: later, context: { infraRetryCount: 1 } }), [], now)).toEqual({ kind: 'retrying', cause: 'infra', resumesAt: later });
    expect(classifyTaskTrouble(pending({ dependsOn: [], startAt: later, context: { budgetExhausted: true } }), [], now)).toEqual({ kind: 'retrying', cause: 'budget', resumesAt: later });
  });
  it('a backoff that has passed is not a retry any more', () => {
    expect(classifyTaskTrouble(pending({ dependsOn: [], startAt: '2026-10-22T11:00:00Z', context: { infraRetryCount: 1 } }), [], now)).toBeNull();
  });
  it('a loop waiting on CI and a queued fix attempt are buildd retrying', () => {
    expect(classifyTaskTrouble(pending({ dependsOn: [], loopState: 'condition_unmet', startAt: later }), [], now)).toEqual({ kind: 'retrying', cause: 'loop', resumesAt: later });
    expect(classifyTaskTrouble(pending({ dependsOn: [], taskClass: 'attempt' }), [], now)).toEqual({ kind: 'retrying', cause: 'attempt', resumesAt: null });
  });
  it('a failed task names what a person must change', () => {
    const failed = (result: unknown) => ({ id: 'a', title: 'Build', status: 'failed', workers: [died], result });
    expect(classifyTaskTrouble(failed({ errorType: 'auth_failure' }), [], now)).toEqual({ kind: 'needs_person', cause: 'auth' });
    expect(classifyTaskTrouble(failed({ error: 'Not logged in · Please run /login' }), [], now)).toEqual({ kind: 'needs_person', cause: 'auth' });
    expect(classifyTaskTrouble(failed({ errorType: 'infra_stalled' }), [], now)).toEqual({ kind: 'needs_person', cause: 'attempts_exhausted' });
    expect(classifyTaskTrouble(failed({ error: 'Task failed after 3 worker attempts' }), [], now)).toEqual({ kind: 'needs_person', cause: 'attempts_exhausted' });
    expect(classifyTaskTrouble(failed({ errorType: 'review_contract_violation' }), [], now)).toEqual({ kind: 'needs_person', cause: 'contract' });
    expect(classifyTaskTrouble(failed({ error: 'boom' }), [], now)).toEqual({ kind: 'needs_person', cause: 'execution' });
  });
  it('a running or merged task is in no trouble', () => {
    expect(classifyTaskTrouble({ id: 'a', title: 'Build', status: 'in_progress' }, [], now)).toBeNull();
    expect(classifyTaskTrouble({ id: 'a', title: 'Build', status: 'completed', workers: [merged] }, [], now)).toBeNull();
  });
});
