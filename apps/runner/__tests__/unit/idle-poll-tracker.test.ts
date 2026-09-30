/**
 * An idle runner (polling, nothing to claim) and a runner that silently
 * stopped polling used to look identical: `no_pending_tasks` polls wrote
 * nothing to claims.log. IdlePollTracker gives the idle state a low-volume
 * trace — one summary on entering idle, then at most one per interval — and
 * a last-poll timestamp for /api/debug/internals.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/idle-poll-tracker.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { IdlePollTracker } from '../../src/idle-poll-tracker';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const HOUR = 60 * 60_000;

describe('IdlePollTracker', () => {
  test('the first idle poll of a streak emits a summary', () => {
    const c = clock();
    const tr = new IdlePollTracker(HOUR, c.now);
    const s = tr.recordIdle();
    expect(s).not.toBeNull();
    expect(s!.idlePolls).toBe(1);
    expect(s!.idleSince).toBe(c.now());
  });

  test('further idle polls inside the interval are counted, not logged', () => {
    const c = clock();
    const tr = new IdlePollTracker(HOUR, c.now);
    tr.recordIdle();
    for (let i = 0; i < 20; i++) {
      c.advance(60_000);
      expect(tr.recordIdle()).toBeNull();
    }
    expect(tr.snapshot().idlePolls).toBe(21);
  });

  test('once the interval passes the next idle poll emits a cumulative summary', () => {
    const c = clock();
    const tr = new IdlePollTracker(HOUR, c.now);
    const start = c.now();
    tr.recordIdle();
    c.advance(30 * 60_000);
    tr.recordIdle();
    c.advance(31 * 60_000);
    const s = tr.recordIdle();
    expect(s).not.toBeNull();
    expect(s!.idlePolls).toBe(3);
    expect(s!.idleSince).toBe(start);
    expect(s!.pollsSinceLastSummary).toBe(2);
  });

  test('a non-idle poll ends the streak; the next idle poll starts a new one', () => {
    const c = clock();
    const tr = new IdlePollTracker(HOUR, c.now);
    tr.recordIdle();
    tr.recordIdle();
    c.advance(1000);
    tr.recordPoll('claimed');
    expect(tr.snapshot().idlePolls).toBe(0);
    expect(tr.snapshot().idleSince).toBeNull();
    c.advance(1000);
    const s = tr.recordIdle();
    expect(s).not.toBeNull();
    expect(s!.idlePolls).toBe(1);
    expect(s!.idleSince).toBe(c.now());
  });

  test('snapshot exposes the last poll time and outcome for any poll', () => {
    const c = clock();
    const tr = new IdlePollTracker(HOUR, c.now);
    expect(tr.snapshot().lastPollAt).toBeNull();
    tr.recordIdle();
    expect(tr.snapshot()).toMatchObject({ lastPollAt: c.now(), lastPollOutcome: 'no_pending_tasks' });
    c.advance(5000);
    tr.recordPoll('rejected');
    expect(tr.snapshot()).toMatchObject({ lastPollAt: c.now(), lastPollOutcome: 'rejected' });
  });
});
