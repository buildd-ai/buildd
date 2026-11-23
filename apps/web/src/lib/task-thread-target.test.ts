import { describe, it, expect } from 'bun:test';
import {
  THREAD_EVENTS,
  parseThreadTarget,
  withThreadTarget,
  threadEventsFor,
  threadNote,
  needsYouNote,
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

describe('needsYouNote (owner-only states)', () => {
  const escalated = { needsYou: true, state: 'ESCALATED', stateReason: 'unsafe_other', prNumber: 6108, headline: 'Needs a person to merge: the migration drops a foreign key' };
  const url = 'https://github.com/o/r/pull/6108';

  it('says "Needs you", names the PR and what is needed, and carries the link', () => {
    const n = needsYouNote({ delivery: escalated, prUrl: url })!;
    expect(n.text).toStartWith('Needs you: PR #6108');
    expect(n.text).toContain('foreign key');
    expect(n.text).toContain(url);
    expect(n.text.split('\n')).toHaveLength(1);
  });

  it('is silent for an ordinary wait', () => {
    expect(needsYouNote({ delivery: { ...escalated, needsYou: false }, prUrl: url })).toBeNull();
    expect(needsYouNote({ delivery: null, prUrl: null })).toBeNull();
  });

  it('dedupes: the same state keeps its key, a new state changes it', () => {
    const a = needsYouNote({ delivery: escalated, prUrl: url })!;
    const again = needsYouNote({ delivery: { ...escalated, headline: 'reworded' }, prUrl: url })!;
    const moved = needsYouNote({ delivery: { ...escalated, state: 'NEEDS_HUMAN', stateReason: 'review' }, prUrl: url })!;
    expect(again.reason).toBe(a.reason);
    expect(moved.reason).not.toBe(a.reason);
  });

  it('a dependency waiting on an escalated PR is named as the cause', () => {
    const n = needsYouNote({ delivery: null, prUrl: null, dependency: { delivery: escalated, prUrl: url } })!;
    expect(n.text).toContain('PR #6108');
    expect(n.text).toContain('waiting on');
  });
});
