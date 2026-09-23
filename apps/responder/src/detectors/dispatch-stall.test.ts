import { describe, expect, test } from 'bun:test';
import {
  dispatchStall,
  FEED_INTERVAL_MINUTES,
  FEED_STALE_AFTER_INTERVALS,
  FLEET_IDLE_JOB,
  SUSTAIN_RUNS,
} from './dispatch-stall';
import type { CronRunRow, Snapshot } from '../types';

const T0 = Date.parse('2026-01-02T12:00:00.000Z');
const HOUR = 3_600_000;

function run(over: Partial<CronRunRow> & { started_at: string }): CronRunRow {
  return {
    job: FLEET_IDLE_JOB,
    finished_at: over.started_at,
    ok: true,
    processed: 1,
    changed: 0,
    errors: 0,
    result: null,
    alerted_at: null,
    ...over,
  };
}

/** An hourly run that found `alarms` problems. `changed` IS the alarm count. */
function alarming(startedAt: string, alarms = 1, claimablePending = 4): CronRunRow {
  return run({
    started_at: startedAt,
    changed: alarms,
    processed: 2,
    result: {
      scope: 'fleet-idle',
      thresholdMinutes: 45,
      alarms,
      claimablePending,
      findings: [{ claimablePending, idleMinutes: 130 }],
    },
  });
}

function quiet(startedAt: string): CronRunRow {
  return run({
    started_at: startedAt,
    changed: 0,
    result: { scope: 'fleet-idle', alarms: 0, claimablePending: 0, findings: [] },
  });
}

/** Rows oldest-first, matching the feed's contract. */
function snapshot(rows: CronRunRow[] | null, over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: new Date(T0).toISOString(),
    claimSamples: [],
    cronRuns: rows,
    appVersion: null,
    runnerVersion: null,
    samplingSince: null,
    ...over,
  };
}

function hoursAgo(n: number): string {
  return new Date(T0 - n * HOUR).toISOString();
}

describe('dispatch-stall thresholds are derived, not guessed', () => {
  test('the feed interval matches the fleet-idle cron schedule', () => {
    // cron-manifest.json: "/api/cron/queue-stall?scope=fleet-idle" on "0 * * * *".
    expect(FEED_INTERVAL_MINUTES).toBe(60);
  });

  test('the sustain threshold is the smallest that survives a full cron interval', () => {
    // One alarming run means the condition held for at least the detector's own
    // 45-minute window at the instant it ran. Two CONSECUTIVE hourly runs means
    // it also survived a whole cron interval, so it cannot be a single blip
    // that happened to land under one tick.
    expect(SUSTAIN_RUNS).toBe(2);
  });
});

describe('dispatch-stall', () => {
  test('fires once the alarm has survived a cron interval', () => {
    const v = dispatchStall.evaluate(
      snapshot([quiet(hoursAgo(4)), quiet(hoursAgo(3)), alarming(hoursAgo(2)), alarming(hoursAgo(1))]),
      T0,
    );
    expect(v.state).toBe('firing');
    expect(v.onsetAt).toBe(hoursAgo(2));
    expect(v.facts.alarmStreak).toBe(2);
  });

  test('a single alarming run is not yet a stall', () => {
    const v = dispatchStall.evaluate(snapshot([quiet(hoursAgo(2)), alarming(hoursAgo(1))]), T0);
    expect(v.state).toBe('clear');
    expect(v.facts.alarmStreak).toBe(1);
  });

  test('a fourteen-hour outage reports the onset, not the latest tick', () => {
    // The shape of the incident: fourteen consecutive hourly runs, each one
    // finding the problem, none of them able to say so.
    const rows = Array.from({ length: 14 }, (_, i) => alarming(hoursAgo(14 - i)));
    const v = dispatchStall.evaluate(snapshot(rows), T0);
    expect(v.state).toBe('firing');
    expect(v.onsetAt).toBe(hoursAgo(14));
    expect(v.facts.alarmStreak).toBe(14);
  });

  test('a clear run ends the streak even with alarms below it', () => {
    const v = dispatchStall.evaluate(
      snapshot([alarming(hoursAgo(4)), alarming(hoursAgo(3)), quiet(hoursAgo(2)), alarming(hoursAgo(1))]),
      T0,
    );
    expect(v.state).toBe('clear');
    expect(v.facts.alarmStreak).toBe(1);
  });

  test('a failed run is transparent — it neither extends nor breaks the streak', () => {
    // `ok: false` means the sweep did not finish, so it carries no verdict.
    // Treating it as a clear would silence a live outage; treating it as an
    // alarm would invent one. It is dropped from the sequence.
    const v = dispatchStall.evaluate(
      snapshot([
        alarming(hoursAgo(3)),
        run({ started_at: hoursAgo(2), ok: false, changed: null, processed: null }),
        alarming(hoursAgo(1)),
      ]),
      T0,
    );
    expect(v.state).toBe('firing');
    expect(v.facts.alarmStreak).toBe(2);
  });

  test('a null changed counter is not a zero', () => {
    // withCronRun records null when the route reported nothing. Reading that
    // as "found nothing" is the inversion that made the incident silent.
    const v = dispatchStall.evaluate(
      snapshot([
        alarming(hoursAgo(3)),
        run({ started_at: hoursAgo(2), changed: null }),
        alarming(hoursAgo(1)),
      ]),
      T0,
    );
    expect(v.facts.alarmStreak).toBe(2);
    expect(v.state).toBe('firing');
  });

  test('a healthy fleet is silent', () => {
    const rows = Array.from({ length: 6 }, (_, i) => quiet(hoursAgo(6 - i)));
    expect(dispatchStall.evaluate(snapshot(rows), T0).state).toBe('clear');
  });

  test('ignores runs of other jobs', () => {
    const v = dispatchStall.evaluate(
      snapshot([
        { ...alarming(hoursAgo(2)), job: 'queue-stall' },
        { ...alarming(hoursAgo(1)), job: 'mission-invariants' },
      ]),
      T0,
    );
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('no_runs_in_feed');
  });
});

describe('dispatch-stall when it cannot see', () => {
  test('an unreadable feed is blind, never clear', () => {
    const v = dispatchStall.evaluate(
      snapshot(null, { cronRunsError: 'connect ETIMEDOUT' }),
      T0,
    );
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('feed_unreadable');
    expect(v.summary).toContain('cannot');
  });

  test('a stale feed is blind — an hourly job with no recent run is not an all-clear', () => {
    const lastAt = hoursAgo(FEED_STALE_AFTER_INTERVALS + 1);
    const v = dispatchStall.evaluate(snapshot([quiet(lastAt)]), T0);
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('feed_stale');
    expect(v.onsetAt).toBe(lastAt);
  });

  test('a feed within the staleness tolerance is evaluated normally', () => {
    const v = dispatchStall.evaluate(snapshot([quiet(hoursAgo(FEED_STALE_AFTER_INTERVALS - 1))]), T0);
    expect(v.state).toBe('clear');
  });

  test('the detector job failing repeatedly is blind, not clear', () => {
    const rows = Array.from({ length: FEED_STALE_AFTER_INTERVALS }, (_, i) =>
      run({ started_at: hoursAgo(FEED_STALE_AFTER_INTERVALS - i), ok: false, changed: null }),
    );
    const v = dispatchStall.evaluate(snapshot(rows), T0);
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('detector_job_failing');
  });
});

describe('dispatch-stall verdict is actionable without a model', () => {
  test('the summary names the condition and when it started', () => {
    const v = dispatchStall.evaluate(
      snapshot([alarming(hoursAgo(2), 1, 7), alarming(hoursAgo(1), 1, 7)]),
      T0,
    );
    expect(v.summary).toContain('Dispatch stall');
    expect(v.summary).toContain(hoursAgo(2));
    expect(v.conditionKey).toBe('dispatch-stall');
  });

  test('facts carry counts, never account identifiers', () => {
    const v = dispatchStall.evaluate(
      snapshot([alarming(hoursAgo(2), 2, 9), alarming(hoursAgo(1), 2, 9)]),
      T0,
    );
    expect(v.facts.claimablePending).toBe(9);
    expect(v.facts.latestAlarmCount).toBe(2);
    expect(JSON.stringify(v.facts)).not.toContain('accountId');
  });
});
