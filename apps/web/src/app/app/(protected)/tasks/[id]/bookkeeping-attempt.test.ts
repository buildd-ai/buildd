import { describe, expect, it } from 'bun:test';
import { bookkeepingAttemptRetry } from './bookkeeping-attempt';

const now = new Date('2026-10-10T13:00:00Z');
const neverStarted = { status: 'failed', exitCause: 'never_started' };

describe('bookkeepingAttemptRetry', () => {
  it('is scheduled when the pending task has a future startAt', () => {
    const startAt = new Date('2026-10-10T13:45:00Z');
    expect(bookkeepingAttemptRetry(neverStarted, { status: 'pending', startAt }, now))
      .toEqual({ kind: 'scheduled', atIso: startAt.toISOString() });
  });
  it('is queued when pending with no wait-until', () => {
    expect(bookkeepingAttemptRetry(neverStarted, { status: 'pending', startAt: null }, now)).toEqual({ kind: 'queued' });
  });
  it('is null once the task is terminal: no retry is promised', () => {
    expect(bookkeepingAttemptRetry(neverStarted, { status: 'failed' }, now)).toBeNull();
  });
  it('is null for a real failure', () => {
    expect(bookkeepingAttemptRetry({ status: 'failed', exitCause: 'infra_failure' }, { status: 'pending' }, now)).toBeNull();
  });
  it('is null for a non-failed worker', () => {
    expect(bookkeepingAttemptRetry({ status: 'running', exitCause: null }, { status: 'pending' }, now)).toBeNull();
  });
});
