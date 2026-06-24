import { describe, it, expect } from 'bun:test';
import {
  RUNNER_POLL_MIN,
  RUNNER_HEARTBEAT_INTERVAL_MS,
  RUNNER_ONLINE_THRESHOLD_MS,
  RUNNER_STALE_CUTOFF_MS,
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
});
