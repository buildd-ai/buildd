import { describe, expect, it } from 'bun:test';
import { classifyTaskFailure, verificationFailedCopy } from './task-failure-kind';

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
