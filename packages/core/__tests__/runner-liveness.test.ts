import { describe, it, expect } from 'bun:test';
import {
  RUNNER_POLL_MIN,
  RUNNER_HEARTBEAT_INTERVAL_MS,
  RUNNER_ONLINE_THRESHOLD_MS,
  RUNNER_STALE_CUTOFF_MS,
  LIVENESS_PING_INTERVAL_MS,
  RUNNER_LIVE_WINDOW_MS,
  RUNNER_RECENTLY_SEEN_MS,
} from '../../shared/src/runner-liveness';

describe('runner-liveness constants', () => {
  it('heartbeat interval equals POLL_MIN converted to ms', () => {
    expect(RUNNER_HEARTBEAT_INTERVAL_MS).toBe(RUNNER_POLL_MIN * 60_000);
  });

  it('online threshold is 1.5× the heartbeat interval', () => {
    expect(RUNNER_ONLINE_THRESHOLD_MS).toBe(1.5 * RUNNER_HEARTBEAT_INTERVAL_MS);
  });

  it('stale cutoff is 2.5× the heartbeat interval', () => {
    expect(RUNNER_STALE_CUTOFF_MS).toBe(2.5 * RUNNER_HEARTBEAT_INTERVAL_MS);
  });

  it('stale cutoff is wider than online threshold', () => {
    expect(RUNNER_STALE_CUTOFF_MS).toBeGreaterThan(RUNNER_ONLINE_THRESHOLD_MS);
  });

  it('default interval is at least 60 minutes', () => {
    // Regression: confirm the interval is not the old ~5-min value.
    expect(RUNNER_HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60_000);
  });

  // The "is this runner up" windows used to be hand-typed literals (3 / 10 /
  // 150 minutes) scattered across the web app. Each answers a different
  // question, so they are different numbers on purpose — but each must be
  // derived from the cadence that makes it true, and they must stay ordered.
  it('online-now window is 3 missed liveness pings', () => {
    expect(RUNNER_LIVE_WINDOW_MS).toBe(3 * LIVENESS_PING_INTERVAL_MS);
  });

  it('recently-seen window is 10 missed liveness pings', () => {
    expect(RUNNER_RECENTLY_SEEN_MS).toBe(10 * LIVENESS_PING_INTERVAL_MS);
  });

  it('windows are strictly ordered: online now < recently seen < not dead', () => {
    expect(RUNNER_LIVE_WINDOW_MS).toBeGreaterThan(LIVENESS_PING_INTERVAL_MS);
    expect(RUNNER_RECENTLY_SEEN_MS).toBeGreaterThan(RUNNER_LIVE_WINDOW_MS);
    expect(RUNNER_STALE_CUTOFF_MS).toBeGreaterThan(RUNNER_RECENTLY_SEEN_MS);
  });

  it('the not-dead cutoff tolerates a dropped beat from a runner that only beats on the poll cycle', () => {
    // A runner build without the 60s liveness ping heartbeats once per poll
    // cycle. Anything that KILLS workers must wait out at least two cycles.
    expect(RUNNER_STALE_CUTOFF_MS).toBeGreaterThanOrEqual(2 * RUNNER_HEARTBEAT_INTERVAL_MS);
  });
});
