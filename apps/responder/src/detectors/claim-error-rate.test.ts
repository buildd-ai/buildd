import { describe, expect, test } from 'bun:test';
import {
  claimErrorRate,
  FAILURE_THRESHOLD,
  MIN_SAMPLES,
  WINDOW_MINUTES,
} from './claim-error-rate';
import type { ClaimSample, Snapshot } from '../types';

const T0 = Date.parse('2026-01-02T12:00:00.000Z');
const MINUTE = 60_000;

function minutesAgo(n: number): string {
  return new Date(T0 - n * MINUTE).toISOString();
}

/** A healthy sample: the probe was refused, which is what it is for. */
function ok(minsAgo: number, latencyMs = 180): ClaimSample {
  return { at: minutesAgo(minsAgo), status: 400, latencyMs, transport: 'responded' };
}

function serverError(minsAgo: number, status = 500, latencyMs = 2400): ClaimSample {
  return { at: minutesAgo(minsAgo), status, latencyMs, transport: 'responded' };
}

function unreachable(minsAgo: number): ClaimSample {
  return {
    at: minutesAgo(minsAgo),
    status: null,
    latencyMs: 15_000,
    transport: 'unreachable',
    transportError: 'connect ECONNREFUSED',
  };
}

function snapshot(samples: ClaimSample[], over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: new Date(T0).toISOString(),
    claimSamples: samples,
    cronRuns: [],
    appVersion: null,
    runnerVersion: null,
    samplingSince: samples[0]?.at ?? null,
    ...over,
  };
}

/** `count` healthy samples, one per minute, oldest first, ending `endMinsAgo` ago. */
function healthyRun(count: number, endMinsAgo = 0): ClaimSample[] {
  return Array.from({ length: count }, (_, i) => ok(count - 1 - i + endMinsAgo));
}

describe('claim-error-rate counts 5xx, not non-2xx', () => {
  test('a refused probe is healthy however many of them there are', () => {
    // The design doc says "non-2xx rate on the claim route". That is wrong for
    // a probe that is structurally guaranteed to be rejected: 4xx is the
    // SUCCESSFUL outcome here, so a non-2xx rate would sit at 100% forever.
    // The measurable is the 5xx / unreachable rate.
    const v = claimErrorRate.evaluate(snapshot(healthyRun(MIN_SAMPLES + 10)), T0);
    expect(v.state).toBe('clear');
    expect(v.facts.failures).toBe(0);
  });

  test('fires at the failure threshold inside the window', () => {
    const samples = [
      ...healthyRun(MIN_SAMPLES + 10, 5),
      serverError(4),
      serverError(3),
      serverError(1),
    ];
    const v = claimErrorRate.evaluate(snapshot(samples), T0);
    expect(v.state).toBe('firing');
    expect(v.facts.failures).toBe(FAILURE_THRESHOLD);
    expect(v.onsetAt).toBe(minutesAgo(4));
  });

  test('stays clear one failure below the threshold', () => {
    const samples = [...healthyRun(MIN_SAMPLES + 10, 5), serverError(4), serverError(2)];
    const v = claimErrorRate.evaluate(snapshot(samples), T0);
    expect(v.state).toBe('clear');
    expect(v.facts.failures).toBe(FAILURE_THRESHOLD - 1);
  });

  test('failures outside the window do not count', () => {
    const samples = [
      serverError(WINDOW_MINUTES + 5),
      serverError(WINDOW_MINUTES + 4),
      serverError(WINDOW_MINUTES + 3),
      ...healthyRun(MIN_SAMPLES + 5),
    ];
    const v = claimErrorRate.evaluate(snapshot(samples), T0);
    expect(v.state).toBe('clear');
    expect(v.facts.failures).toBe(0);
  });

  test('an unreachable endpoint counts as a failure', () => {
    // Connection refused is the same statement as a 5xx for this detector's
    // purpose -- the claim path is not serving -- and excluding it would let a
    // total outage read as clear, which is the worst available answer.
    const samples = [...healthyRun(MIN_SAMPLES + 10, 5), unreachable(4), unreachable(3), unreachable(2)];
    const v = claimErrorRate.evaluate(snapshot(samples), T0);
    expect(v.state).toBe('firing');
    expect(v.facts.unreachable).toBe(3);
    expect(v.facts.serverErrors).toBe(0);
  });

  test('facts separate 5xx from unreachable so the page says which', () => {
    const samples = [
      ...healthyRun(MIN_SAMPLES + 10, 5),
      serverError(4, 503),
      unreachable(3),
      serverError(2, 500),
    ];
    const v = claimErrorRate.evaluate(snapshot(samples), T0);
    expect(v.facts.serverErrors).toBe(2);
    expect(v.facts.unreachable).toBe(1);
    expect(v.facts.statuses).toEqual({ '500': 1, '503': 1 });
  });

  test('records the latency multiple, the shape the incident 5xx had', () => {
    const samples = [
      ...healthyRun(MIN_SAMPLES + 10, 5).map(s => ({ ...s, latencyMs: 200 })),
      serverError(4, 500, 2000),
      serverError(3, 500, 2000),
      serverError(2, 500, 2000),
    ];
    const v = claimErrorRate.evaluate(snapshot(samples), T0);
    expect(v.facts.healthyMedianLatencyMs).toBe(200);
    expect(v.facts.failureMedianLatencyMs).toBe(2000);
  });
});

describe('claim-error-rate when it cannot see', () => {
  test('a cold start is warming, not clear and not a page', () => {
    const samples = healthyRun(3);
    const v = claimErrorRate.evaluate(
      snapshot(samples, { samplingSince: minutesAgo(3) }),
      T0,
    );
    expect(v.state).toBe('warming');
    expect(v.onsetAt).toBeNull();
  });

  test('too few samples after a full window of watching is blind', () => {
    // The responder has been up longer than the window and still has almost no
    // samples: the probe is not recording. Reporting that as health is the
    // failure class this whole app is about.
    const v = claimErrorRate.evaluate(
      snapshot([ok(70), ok(2)], { samplingSince: minutesAgo(WINDOW_MINUTES + 30) }),
      T0,
    );
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('too_few_samples');
  });

  test('no samples at all with no sampling history is warming', () => {
    const v = claimErrorRate.evaluate(snapshot([], { samplingSince: null }), T0);
    expect(v.state).toBe('warming');
  });

  test('a probe the route ACCEPTED invalidates the instrument — blind, loudly', () => {
    // A 2xx means the claim route accepted a body it is required to refuse,
    // so the probe may have claimed real work. Every later sample from that
    // endpoint is untrustworthy, and this must never be read as health.
    const samples = [
      ...healthyRun(MIN_SAMPLES + 10, 2),
      { at: minutesAgo(1), status: 200, latencyMs: 300, transport: 'responded' as const },
    ];
    const v = claimErrorRate.evaluate(snapshot(samples), T0);
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('probe_accepted');
    expect(v.summary).toContain('may have claimed');
    expect(v.onsetAt).toBe(minutesAgo(1));
  });

  test('a rejected responder credential is blind, not a platform outage', () => {
    // Held to the same failure threshold: one 401 can be a transient, a rate
    // of them is a revoked or rotated key. Either way the responder is
    // disarmed, and that is a different page from "the platform is down".
    const samples = [
      ...healthyRun(MIN_SAMPLES + 10, 4),
      { at: minutesAgo(3), status: 401, latencyMs: 120, transport: 'responded' as const },
      { at: minutesAgo(2), status: 401, latencyMs: 120, transport: 'responded' as const },
      { at: minutesAgo(1), status: 401, latencyMs: 120, transport: 'responded' as const },
    ];
    const v = claimErrorRate.evaluate(snapshot(samples), T0);
    expect(v.state).toBe('blind');
    expect(v.facts.reason).toBe('probe_credential_rejected');
    expect(v.onsetAt).toBe(minutesAgo(3));
  });

  test('a single auth rejection is not yet a disarmed responder', () => {
    const samples = [
      ...healthyRun(MIN_SAMPLES + 10, 2),
      { at: minutesAgo(1), status: 401, latencyMs: 120, transport: 'responded' as const },
    ];
    expect(claimErrorRate.evaluate(snapshot(samples), T0).state).toBe('clear');
  });
});

describe('claim-error-rate verdict is actionable without a model', () => {
  test('the summary names the condition, the rate and the onset', () => {
    const samples = [
      ...healthyRun(MIN_SAMPLES + 10, 5),
      serverError(4),
      serverError(3),
      serverError(2),
    ];
    const v = claimErrorRate.evaluate(snapshot(samples), T0);
    expect(v.summary).toContain('Claim endpoint errors');
    expect(v.summary).toContain(minutesAgo(4));
    expect(v.conditionKey).toBe('claim-error-rate');
  });
});
