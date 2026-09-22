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

/**
 * A `findings`-polarity job's `changed` counts problems FOUND, not work done.
 * The queue-stall detector ran hourly, correctly finding a real outage every
 * single run, and reported the same nonzero `changed` a maximally productive
 * `work` job would — which read as maximally healthy while the outage was at
 * its worst. This is the inverted alarm that closes that gap.
 */
describe('evaluateCronHealth — findings polarity', () => {
  const finding = (agoHours: number, changed = 1) => run({ agoHours, errors: 0, changed });

  it('alarms when the job keeps finding something, run after run', () => {
    const verdict = evaluateCronHealth([finding(1), finding(2), finding(3)], NOW, 'findings');
    expect(verdict.alarm).toBe(true);
    expect(verdict.reason).toContain('consecutive runs');
    expect(verdict.reason).toContain('not clearing on its own');
  });

  it('does NOT alarm once findings clear — the most recent run reporting zero self-clears it', () => {
    const runs = [run({ agoHours: 1, changed: 0 }), finding(2), finding(3)];
    expect(evaluateCronHealth(runs, NOW, 'findings').alarm).toBe(false);
  });

  it('does NOT alarm on a healthy detector with nothing to find', () => {
    const runs = [run({ agoHours: 1 }), run({ agoHours: 2 }), run({ agoHours: 3 })];
    expect(evaluateCronHealth(runs, NOW, 'findings').alarm).toBe(false);
  });

  it('a `work` job with the identical run history stays quiet — polarity, not data, decides', () => {
    // Same three runs that alarm above under 'findings' must NOT alarm under
    // the default 'work' polarity: nonzero `changed` still reads as health.
    const runs = [finding(1), finding(2), finding(3)];
    expect(evaluateCronHealth(runs, NOW).alarm).toBe(false);
    expect(evaluateCronHealth(runs, NOW, 'work').alarm).toBe(false);
  });

  it('still alarms on a findings job that is actually crashing every run (the work-style check still applies)', () => {
    const verdict = evaluateCronHealth([deadRun(1), deadRun(2), deadRun(3)], NOW, 'findings');
    expect(verdict.alarm).toBe(true);
    expect(verdict.reason).toContain('0 changed');
  });

  it('stays quiet after a recent alert instead of paging every hour', () => {
    const runs = [finding(1), finding(2), { ...finding(3), alertedAt: new Date(NOW.getTime() - 2 * HOUR) }];
    expect(evaluateCronHealth(runs, NOW, 'findings').alarm).toBe(false);
  });

  it('does not judge on too few runs', () => {
    const runs = Array.from({ length: MIN_RUNS_FOR_ALARM - 1 }, (_, i) => finding(i + 1));
    expect(evaluateCronHealth(runs, NOW, 'findings').alarm).toBe(false);
  });
});
