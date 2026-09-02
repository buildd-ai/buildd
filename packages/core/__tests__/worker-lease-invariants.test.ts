import { describe, it, expect } from 'bun:test';
import {
  WORKER_LEASE_TTL_MS,
  WORKER_LEASE_RENEW_INTERVAL_MS,
  WORKER_LEASE_MISSED_BEATS_TOLERATED,
  WORKER_STALE_REAP_MS,
  LIVENESS_PING_INTERVAL_MS,
} from '@buildd/shared';

/**
 * The lease exists to replace INFERRED liveness with ASSERTED liveness.
 *
 * The legacy rule reads `workers.updatedAt`, which only advances as a side
 * effect of the runner syncing a state CHANGE — so a worker busy inside one long
 * silent tool call and a worker whose process died look identical (silence), and
 * any single threshold is at once too short (kills healthy work) and too long
 * (orphans hold concurrency seats).
 *
 * A lease renewed from a TIMER breaks that tie, which is what lets the reap
 * window get tighter rather than looser. These invariants guard the arithmetic
 * that makes it safe.
 */
describe('worker lease invariants', () => {
  it('tolerates at least one missed renewal', () => {
    // A TTL at or below the renew interval would expire healthy workers in the
    // gap between two beats — the failure mode this whole change exists to end.
    expect(WORKER_LEASE_TTL_MS).toBeGreaterThan(WORKER_LEASE_RENEW_INTERVAL_MS);
    expect(WORKER_LEASE_MISSED_BEATS_TOLERATED).toBeGreaterThanOrEqual(1);
  });

  it('tolerates enough missed beats to ride out a blip or a cold start', () => {
    // 4 at the chosen 60s/5min pairing. Below ~3 a single slow round-trip to a
    // suspended Neon instance starts killing live workers.
    expect(WORKER_LEASE_MISSED_BEATS_TOLERATED).toBeGreaterThanOrEqual(3);
  });

  it('renews on the existing liveness ping so there is one liveness signal', () => {
    // Renewal deliberately rides the ping that already exists rather than adding
    // a second, separately-drifting cadence.
    expect(WORKER_LEASE_RENEW_INTERVAL_MS).toBe(LIVENESS_PING_INTERVAL_MS);
  });

  it('reclaims orphans faster than the legacy rule it will replace', () => {
    // The entire point: asserted liveness permits a much tighter window. If this
    // ever inverted, the lease would be strictly worse than what it replaces.
    expect(WORKER_LEASE_TTL_MS).toBeLessThan(WORKER_STALE_REAP_MS);
  });
});
