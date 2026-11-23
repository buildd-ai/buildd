import { describe, it, expect } from 'bun:test';
import {
  THREAD_EVENTS,
  parseThreadTarget,
  withThreadTarget,
  selectCallbackTargets,
  threadEventsFor,
  threadNote,
} from './task-thread-target';

describe('parseThreadTarget', () => {
  it('accepts a t3_thread target with a bounded thread id', () => {
    expect(parseThreadTarget({ kind: 't3_thread', threadId: 'new-abc' })).toEqual({ kind: 't3_thread', threadId: 'new-abc' });
  });
  it('rejects other kinds, empty or oversized ids, and extra secrets', () => {
    expect(parseThreadTarget({ kind: 'slack', threadId: 'x' })).toBeNull();
    expect(parseThreadTarget({ kind: 't3_thread', threadId: '' })).toBeNull();
    expect(parseThreadTarget({ kind: 't3_thread', threadId: 'x'.repeat(200) })).toBeNull();
    expect(parseThreadTarget('t3_thread')).toBeNull();
    expect(parseThreadTarget({ kind: 't3_thread', threadId: 'a', token: 'secret' })).toEqual({ kind: 't3_thread', threadId: 'a' });
  });
});

describe('withThreadTarget', () => {
  it('replaces a caller-supplied target with the sanitized one, or drops an invalid one', () => {
    expect(withThreadTarget({ callbackTarget: { kind: 't3_thread', threadId: 'a', token: 's' } }).callbackTarget)
      .toEqual({ kind: 't3_thread', threadId: 'a' });
    expect('callbackTarget' in withThreadTarget({ callbackTarget: { kind: 'bogus' }, other: 1 })).toBe(false);
    expect(withThreadTarget(null)).toEqual({});
  });
});

describe('selectCallbackTargets', () => {
  it('returns url and thread targets independently', () => {
    expect(selectCallbackTargets({})).toEqual([]);
    expect(selectCallbackTargets({ callback: { url: 'https://x.test/h' } })).toEqual(['url']);
    expect(selectCallbackTargets({ callbackTarget: { kind: 't3_thread', threadId: 'a' } })).toEqual(['t3_thread']);
    expect(selectCallbackTargets({ callback: { url: 'https://x.test/h' }, callbackTarget: { kind: 't3_thread', threadId: 'a' } }))
      .toEqual(['url', 't3_thread']);
  });
  it('ignores a non-https url', () => {
    expect(selectCallbackTargets({ callback: { url: 'http://x.test' } })).toEqual([]);
  });
});

describe('threadEventsFor', () => {
  const base = { taskStatus: 'pending', workerStatus: null, prUrl: null, hasWorker: false };
  it('is empty before any worker', () => {
    expect(threadEventsFor(base)).toEqual([]);
  });
  it('started once a worker exists', () => {
    expect(threadEventsFor({ ...base, taskStatus: 'in_progress', workerStatus: 'running', hasWorker: true })).toEqual(['started']);
  });
  it('waiting_input only while the worker waits', () => {
    expect(threadEventsFor({ ...base, taskStatus: 'in_progress', workerStatus: 'waiting_input', hasWorker: true })).toEqual(['started', 'waiting_input']);
  });
  it('pr_opened when a PR exists, completed and failed are terminal and imply earlier events', () => {
    expect(threadEventsFor({ ...base, taskStatus: 'in_progress', workerStatus: 'running', hasWorker: true, prUrl: 'https://github.com/o/r/pull/1' }))
      .toEqual(['started', 'pr_opened']);
    expect(threadEventsFor({ ...base, taskStatus: 'completed', workerStatus: 'completed', hasWorker: true, prUrl: 'https://github.com/o/r/pull/1' }))
      .toEqual(['started', 'pr_opened', 'completed']);
    expect(threadEventsFor({ ...base, taskStatus: 'failed', workerStatus: 'failed', hasWorker: true })).toEqual(['started', 'failed']);
  });
  it('only emits vocabulary events', () => {
    for (const e of threadEventsFor({ taskStatus: 'completed', workerStatus: 'completed', hasWorker: true, prUrl: 'u' })) expect(THREAD_EVENTS).toContain(e);
  });
});

describe('threadNote', () => {
  it('is short, names the task, and carries the PR link only when it has one', () => {
    expect(threadNote('pr_opened', { title: 'Fix it', prUrl: 'https://github.com/o/r/pull/9' })).toContain('https://github.com/o/r/pull/9');
    expect(threadNote('started', { title: 'Fix it' })).toContain('Fix it');
    expect(threadNote('waiting_input', { title: 'Fix it' }).length).toBeLessThan(200);
    expect(threadNote('failed', { title: 'Fix it' })).toMatch(/failed/i);
  });
});
