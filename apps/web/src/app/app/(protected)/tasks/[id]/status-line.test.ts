/**
 * The task's state under its title while a builder runs (Navigation: one
 * place per task, R-14 and R-7): `Running 12m`, or the stall line once the
 * run has reported nothing for 30 minutes.
 */
import { describe, expect, it } from 'bun:test';
import { runningStatusLine } from './status-line';

const T0 = Date.parse('2026-10-23T10:00:00.000Z');
const MIN = 60_000;

describe('runningStatusLine', () => {
  it('reads Running and how long it has run', () => {
    const line = runningStatusLine({ status: 'running', startedAt: new Date(T0).toISOString(), milestones: [{ ts: T0 + 11 * MIN }], waiting: false, nowMs: T0 + 12 * MIN });
    expect(line).toEqual({ text: 'Running 12m', stalled: false });
  });

  it('a run with no progress for 30 minutes says so (R-7)', () => {
    const line = runningStatusLine({ status: 'running', startedAt: new Date(T0).toISOString(), milestones: [{ ts: T0 + 24 * MIN }], waiting: false, nowMs: T0 + 72 * MIN });
    expect(line).toEqual({ text: 'Running 1h 12m · no progress for 48m', stalled: true });
  });

  it('a starting run with no start time yet still reads Running', () => {
    expect(runningStatusLine({ status: 'starting', startedAt: null, milestones: [], waiting: false, nowMs: T0 })).toEqual({ text: 'Running', stalled: false });
  });

  it('no line for a run that waits on an answer or has ended', () => {
    expect(runningStatusLine({ status: 'waiting_input', startedAt: new Date(T0).toISOString(), milestones: [], waiting: true, nowMs: T0 })).toBeNull();
    expect(runningStatusLine({ status: 'running', startedAt: new Date(T0).toISOString(), milestones: [], waiting: true, nowMs: T0 })).toBeNull();
    expect(runningStatusLine({ status: 'completed', startedAt: new Date(T0).toISOString(), milestones: [], waiting: false, nowMs: T0 })).toBeNull();
  });
});
