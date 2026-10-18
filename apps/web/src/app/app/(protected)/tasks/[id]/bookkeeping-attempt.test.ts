import { describe, expect, it } from 'bun:test';
import { bookkeepingAttemptRetry, groupAttemptHistory } from './bookkeeping-attempt';
import { CLAIM_RESPONSE_LOST_ERROR, NEVER_STARTED_ERROR } from '@/lib/worker-exit-taxonomy';

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
  it('is settled once the task is terminal: no retry is promised, and it is still not a failure', () => {
    for (const status of ['failed', 'completed', 'cancelled']) {
      expect(bookkeepingAttemptRetry(neverStarted, { status }, now)).toEqual({ kind: 'settled' });
    }
  });
  it('is null for a real failure', () => {
    expect(bookkeepingAttemptRetry({ status: 'failed', exitCause: 'infra_failure' }, { status: 'pending' }, now)).toBeNull();
  });
  it('is null for a non-failed worker', () => {
    expect(bookkeepingAttemptRetry({ status: 'running', exitCause: null }, { status: 'pending' }, now)).toBeNull();
  });
});

describe('groupAttemptHistory', () => {
  const lost = (id: string) => ({ id, worker: { status: 'failed', exitCause: 'never_started', error: CLAIM_RESPONSE_LOST_ERROR } });
  const reaped = (id: string) => ({ id, worker: { status: 'failed', exitCause: 'never_started', error: NEVER_STARTED_ERROR } });
  const ran = (id: string, status = 'completed') => ({ id, worker: { status, exitCause: null, error: null } });

  it('collapses consecutive lost claims into one undelivered line that promises the retry', () => {
    const items = groupAttemptHistory([lost('a'), lost('b'), lost('c')], { status: 'pending', startAt: null }, now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'bookkeeping', undelivered: true, retry: { kind: 'queued' } });
    expect((items[0] as any).entries.map((e: any) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps real attempts as their own rows and settles the bookkeeping run behind them', () => {
    // Newest first: the run that shipped, then three lost claims before it.
    const items = groupAttemptHistory([ran('d'), lost('c'), lost('b'), lost('a')], { status: 'completed' }, now);
    expect(items.map(i => i.kind)).toEqual(['attempt', 'bookkeeping']);
    expect(items[1]).toMatchObject({ retry: { kind: 'settled' }, undelivered: true });
  });

  it('a real failure between two runs splits them, and a mixed run is not called undelivered', () => {
    const items = groupAttemptHistory([lost('e'), reaped('d'), ran('c', 'failed'), lost('b')], { status: 'pending', startAt: null }, now);
    expect(items.map(i => i.kind)).toEqual(['bookkeeping', 'attempt', 'bookkeeping']);
    expect(items[0]).toMatchObject({ undelivered: false, retry: { kind: 'queued' } });
    expect((items[0] as any).entries).toHaveLength(2);
    expect(items[2]).toMatchObject({ retry: { kind: 'settled' } });
  });

  it('passes an ordinary history through untouched', () => {
    const items = groupAttemptHistory([ran('b', 'failed'), ran('a')], { status: 'failed' }, now);
    expect(items).toEqual([{ kind: 'attempt', entry: ran('b', 'failed') }, { kind: 'attempt', entry: ran('a') }]);
  });
});
