import { describe, expect, it } from 'bun:test';
import { runStall, STALL_AFTER_MS } from './run-stall';

const MIN = 60_000;
const start = Date.UTC(2026, 9, 22, 12, 0);

describe('runStall (Navigation R-7, AC-15)', () => {
  it('flags a run with no progress for 30 minutes, in the spec words', () => {
    const stall = runStall({ status: 'running', startMs: start, progressMs: start + 24 * MIN, nowMs: start + 72 * MIN });
    expect(stall).toEqual({ quietMs: 48 * MIN, label: 'Running 1h 12m · no progress for 48m' });
  });

  it('does not flag progress inside the window', () => {
    expect(runStall({ status: 'running', startMs: start, progressMs: start + 60 * MIN, nowMs: start + 60 * MIN + STALL_AFTER_MS - 1 })).toBeNull();
  });

  it('counts from the start when nothing was reported yet', () => {
    expect(runStall({ status: 'running', startMs: start, progressMs: null, nowMs: start + 31 * MIN })?.label).toBe('Running 31m · no progress for 31m');
  });

  it('never flags a run that is not running (paused, waiting on an answer, starting)', () => {
    for (const status of ['waiting_input', 'starting', 'completed', 'failed']) {
      expect(runStall({ status, startMs: start, progressMs: start, nowMs: start + 5 * 60 * MIN })).toBeNull();
    }
  });

  it('reads nothing without a start time', () => {
    expect(runStall({ status: 'running', startMs: null, progressMs: null, nowMs: start })).toBeNull();
  });
});
