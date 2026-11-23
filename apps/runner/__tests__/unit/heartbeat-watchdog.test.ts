/**
 * Heartbeat watchdog (2026-11-22 incident): a runner stopped heartbeating with
 * the process up and nothing in its log, and stayed invisible until a manual
 * restart. Failures must be logged, and a dead or stale heartbeat must restart
 * the runner, except when the server is answering with a refusal.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/heartbeat-watchdog.test.ts
 */
import { describe, test, expect } from 'bun:test';
import {
  HeartbeatTracker,
  HeartbeatWatchdog,
  heartbeatWatchdogVerdict,
  HEARTBEAT_FAILURE_LOG_EVERY_MS,
} from '../../src/heartbeat-watchdog';
import { ServerRefusalError } from '../../src/server-refusal';

const MIN = 60_000;
const T = { staleMs: 45 * MIN, tickStallMs: 5 * MIN, hangMs: 5 * MIN };
const transportErr = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
const refusal = () => ServerRefusalError.from({ status: 401, raw: '{"error":"invalid key"}', method: 'POST', endpoint: '/api/workers/heartbeat' });

function armed(at = 0) {
  const t = new HeartbeatTracker(at);
  t.arm(at);
  return t;
}

describe('HeartbeatTracker logging', () => {
  test('the first failure of a streak is logged with its cause', () => {
    const t = armed();
    const line = t.fail(t.begin(1000), transportErr, 1000);
    expect(line).toContain('[heartbeat] beat failed');
    expect(line).toContain('transport');
    expect(line).toContain('timed out');
    expect(line).toContain('1 in a row');
  });

  test('a continuing streak is rate limited, then logged again', () => {
    const t = armed();
    expect(t.fail(t.begin(0), transportErr, 0)).not.toBeNull();
    expect(t.fail(t.begin(MIN), transportErr, MIN)).toBeNull();
    const again = t.fail(t.begin(HEARTBEAT_FAILURE_LOG_EVERY_MS), transportErr, HEARTBEAT_FAILURE_LOG_EVERY_MS);
    expect(again).toContain('3 in a row');
  });

  test('a success after failures logs recovery; a plain success logs nothing', () => {
    const t = armed();
    expect(t.succeed(t.begin(0), 0)).toBeNull();
    t.fail(t.begin(MIN), transportErr, MIN);
    t.fail(t.begin(2 * MIN), transportErr, 2 * MIN);
    expect(t.succeed(t.begin(3 * MIN), 3 * MIN)).toContain('recovered after 2 failed beats');
    expect(t.snapshot().consecutiveFailures).toBe(0);
  });

  test('a server refusal is classified as refused', () => {
    const t = armed();
    t.fail(t.begin(0), refusal(), 0);
    expect(t.snapshot().lastFailureKind).toBe('refused');
  });
});

describe('heartbeatWatchdogVerdict', () => {
  test('an unarmed tracker (serverless, loop never started) is never judged', () => {
    const t = new HeartbeatTracker(0);
    expect(heartbeatWatchdogVerdict(t.snapshot(), 10 * 60 * MIN, T).kind).toBe('ok');
  });

  test('healthy: ticking, beats landing', () => {
    const t = armed();
    t.noteTick(40 * MIN);
    t.succeed(t.begin(40 * MIN), 40 * MIN);
    expect(heartbeatWatchdogVerdict(t.snapshot(), 41 * MIN, T).kind).toBe('ok');
  });

  test('the liveness timer stopped firing: restart', () => {
    const t = armed();
    t.succeed(t.begin(0), 0);
    const v = heartbeatWatchdogVerdict(t.snapshot(), 6 * MIN, T);
    expect(v.kind).toBe('restart');
    if (v.kind === 'restart') expect(v.reason).toContain('timer has not fired');
  });

  test('a beat hung far past the fetch timeout: restart', () => {
    const t = armed();
    t.begin(0);
    t.noteTick(6 * MIN);
    const v = heartbeatWatchdogVerdict(t.snapshot(), 6 * MIN, T);
    expect(v.kind).toBe('restart');
    if (v.kind === 'restart') expect(v.reason).toContain('in flight');
  });

  test('ticking but no beat landing on transport faults past the stale window: restart', () => {
    const t = armed();
    t.succeed(t.begin(0), 0);
    for (let m = 1; m <= 46; m++) {
      t.noteTick(m * MIN);
      t.fail(t.begin(m * MIN), transportErr, m * MIN);
    }
    expect(heartbeatWatchdogVerdict(t.snapshot(), 44 * MIN, T).kind).toBe('ok');
    const v = heartbeatWatchdogVerdict(t.snapshot(), 46 * MIN, T);
    expect(v.kind).toBe('restart');
    if (v.kind === 'restart') expect(v.reason).toContain('no heartbeat has landed');
  });

  test('ticking but no beat attempted at all past the stale window: restart', () => {
    const t = armed();
    t.noteTick(46 * MIN);
    expect(heartbeatWatchdogVerdict(t.snapshot(), 46 * MIN, T).kind).toBe('restart');
  });

  test('the server refusing beats is reported, not restarted', () => {
    const t = armed();
    t.noteTick(46 * MIN);
    t.fail(t.begin(46 * MIN), refusal(), 46 * MIN);
    expect(heartbeatWatchdogVerdict(t.snapshot(), 46 * MIN, T).kind).toBe('stale-refused');
  });
});

describe('HeartbeatWatchdog', () => {
  test('restarts once the verdict says so', () => {
    const t = armed();
    const w = new HeartbeatWatchdog({ intervalMs: MIN, thresholds: T });
    for (let m = 1; m <= 5; m++) expect(w.check(t, m * MIN)).toBeNull();
    const d = w.check(t, 6 * MIN);
    expect(d?.action).toBe('restart');
    expect(d?.message).toContain('[heartbeat-watchdog]');
  });

  test('a suspended process (gap in its own checks) resets the baseline instead of restarting', () => {
    const t = armed();
    t.succeed(t.begin(0), 0);
    const w = new HeartbeatWatchdog({ intervalMs: MIN, thresholds: T });
    expect(w.check(t, MIN)).toBeNull();
    // Laptop slept for two hours: no timers fired, no beats were sent.
    expect(w.check(t, 121 * MIN)).toBeNull();
    // The timer resumes after waking; nothing is stale relative to the wake.
    t.noteTick(122 * MIN);
    expect(w.check(t, 122 * MIN)).toBeNull();
  });

  test('stale-refused logs, rate limited', () => {
    const t = armed();
    const w = new HeartbeatWatchdog({ intervalMs: MIN, thresholds: T, refusedLogEveryMs: 10 * MIN });
    const results: Array<string | null> = [];
    for (let m = 1; m <= 60; m++) {
      t.noteTick(m * MIN);
      t.fail(t.begin(m * MIN), refusal(), m * MIN);
      const d = w.check(t, m * MIN);
      if (d) expect(d.action).toBe('log');
      results.push(d?.message ?? null);
    }
    const logged = results.filter(Boolean);
    expect(logged.length).toBe(2); // minute 46 and minute 56
    expect(logged[0]).toContain('refusing');
  });
});
