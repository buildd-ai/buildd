process.env.NODE_ENV = 'test';

import { describe, it, expect } from 'bun:test';
import {
  evaluateCronHealth,
  MIN_RUNS_FOR_ALARM,
  ALERT_SUPPRESS_MS,
  type CronRunSummary,
} from './cron-health';

/**
 * The signal three PR sweeps emitted hourly for months while completely dead:
 * every row errored, nothing changed. Nothing read it, because the verdict was
 * discarded at the route boundary (PR #2125). This is the reader.
 *
 * The hard part is not detecting failure, it is not crying wolf at a sweep with
 * nothing to do — which reports the same processed=0/changed=0 as a sweep that
 * cannot do anything. `errors` is what separates them.
 */

const NOW = new Date('2026-09-06T20:00:00Z');
const HOUR = 60 * 60 * 1000;

function run(over: Partial<CronRunSummary> & { agoHours?: number } = {}): CronRunSummary {
  const { agoHours = 1, ...rest } = over;
  return {
    ok: true,
    errors: 0,
    changed: 0,
    alertedAt: null,
    startedAt: new Date(NOW.getTime() - agoHours * HOUR),
    ...rest,
  };
}

/** A run of the shape the dead sweeps produced: everything errored, nothing landed. */
const deadRun = (agoHours: number) => run({ agoHours, errors: 40, changed: 0 });

describe('evaluateCronHealth', () => {
  it('alarms when every run in the window errored and nothing changed', () => {
    const verdict = evaluateCronHealth([deadRun(1), deadRun(2), deadRun(3)], NOW);
    expect(verdict.alarm).toBe(true);
    expect(verdict.reason).toContain('0 changed');
  });

  it('does NOT alarm on a healthy sweep with nothing to do', () => {
    // The false positive that would make this monitor worthless. processed=0,
    // changed=0 and errors=0 is a correct, idle sweep.
    const verdict = evaluateCronHealth([run(), run({ agoHours: 2 }), run({ agoHours: 3 })], NOW);
    expect(verdict.alarm).toBe(false);
  });

  it('does NOT alarm while the sweep is still accomplishing something', () => {
    // Partial errors with real work landing is degraded, not dead. Paging here
    // trains you to ignore the page.
    const runs = [
      run({ agoHours: 1, errors: 5, changed: 12 }),
      deadRun(2),
      deadRun(3),
    ];
    expect(evaluateCronHealth(runs, NOW).alarm).toBe(false);
  });

  it('alarms when the handler throws on every run', () => {
    const runs = [
      run({ agoHours: 1, ok: false, errors: null, changed: null }),
      run({ agoHours: 2, ok: false, errors: null, changed: null }),
      run({ agoHours: 3, ok: false, errors: null, changed: null }),
    ];
    const verdict = evaluateCronHealth(runs, NOW);
    expect(verdict.alarm).toBe(true);
    expect(verdict.reason).toContain('did not finish');
  });

  it('does not judge on too few runs', () => {
    // One bad run is a blip — a rate limit, a deploy mid-flight.
    const runs = Array.from({ length: MIN_RUNS_FOR_ALARM - 1 }, (_, i) => deadRun(i + 1));
    expect(evaluateCronHealth(runs, NOW).alarm).toBe(false);
    expect(evaluateCronHealth([], NOW).alarm).toBe(false);
  });

  it('stays quiet after a recent alert instead of paging every hour', () => {
    const runs = [deadRun(1), deadRun(2), { ...deadRun(3), alertedAt: new Date(NOW.getTime() - 2 * HOUR) }];
    expect(evaluateCronHealth(runs, NOW).alarm).toBe(false);
  });

  it('alarms again once the suppression window lapses', () => {
    const stale = new Date(NOW.getTime() - ALERT_SUPPRESS_MS - HOUR);
    const runs = [deadRun(1), deadRun(2), { ...deadRun(3), alertedAt: stale }];
    expect(evaluateCronHealth(runs, NOW).alarm).toBe(true);
  });

  it('treats a run that reported no verdict as neither healthy nor failing', () => {
    // A route that never calls report() still writes a heartbeat row. It must
    // not count as a failure (it did not fail) nor mask one (it proves nothing).
    const runs = [run({ errors: null, changed: null }), deadRun(2), deadRun(3)];
    expect(evaluateCronHealth(runs, NOW).alarm).toBe(false);
  });

  it('names the job trend in the reason so the alert is actionable', () => {
    const verdict = evaluateCronHealth([deadRun(1), deadRun(2), deadRun(3)], NOW);
    expect(verdict.reason).toMatch(/3 runs/);
    expect(verdict.reason).toMatch(/120 error/); // 40 per run, summed
  });
});
