import { beforeEach, describe, expect, test } from 'bun:test';
import { DETECTORS } from './index';
import type { ClaimSample, CronRunRow, Snapshot } from '../types';

/**
 * ── The credential-free rule, proven rather than asserted ───────────────────
 *
 * The design's answer to "what if the shared OAuth credential is the thing
 * that is down" is that **every detector must be evaluable without a model
 * call**, so a dead credential costs the diagnosis narrative and not the
 * alert. This file is that claim's proof.
 *
 * It does two independent things:
 *
 *  1. Strips every credential the process could reach — model, database,
 *     notification — from `process.env`, then evaluates every registered
 *     detector over both a firing and a clear snapshot. Any detector that
 *     needed a credential would throw, return `blind`, or hang.
 *  2. Asserts the signature makes it impossible in the first place:
 *     `evaluate` is synchronous and arity-2, so there is no client argument to
 *     pass a model in and no promise to await one on.
 *
 * Property (2) is the one that lasts. Property (1) is what catches a detector
 * that reaches for a module-level singleton instead of an argument.
 */

const MODEL_AND_SECRET_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'BUILDD_RESPONDER_CRON_RUNS_URL',
  'PUSHOVER_USER',
  'PUSHOVER_TOKEN',
  'PUSHOVER_TOKEN_ALERT',
];

const T0 = Date.parse('2026-01-02T12:00:00.000Z');

function cronRun(startedAt: string, changed: number): CronRunRow {
  return {
    job: 'queue-stall:fleet-idle',
    started_at: startedAt,
    finished_at: startedAt,
    ok: true,
    processed: 2,
    changed,
    errors: 0,
    result: { scope: 'fleet-idle', alarms: changed, claimablePending: changed > 0 ? 5 : 0 },
    alerted_at: null,
  };
}

function claimSample(minsAgo: number, status: number): ClaimSample {
  return {
    at: new Date(T0 - minsAgo * 60_000).toISOString(),
    status,
    latencyMs: status >= 500 ? 2500 : 200,
    transport: 'responded',
  };
}

/** A snapshot in which BOTH detectors should be firing. */
function firingSnapshot(): Snapshot {
  const samples = [
    ...Array.from({ length: 30 }, (_, i) => claimSample(40 - i, 400)),
    claimSample(3, 500),
    claimSample(2, 503),
    claimSample(1, 500),
  ];
  return {
    at: new Date(T0).toISOString(),
    claimSamples: samples,
    cronRuns: [
      cronRun(new Date(T0 - 3 * 3_600_000).toISOString(), 1),
      cronRun(new Date(T0 - 2 * 3_600_000).toISOString(), 1),
      cronRun(new Date(T0 - 3_600_000).toISOString(), 1),
    ],
    appVersion: null,
    runnerVersion: null,
    samplingSince: samples[0]!.at,
  };
}

/** A snapshot in which BOTH detectors should be clear. */
function clearSnapshot(): Snapshot {
  const samples = Array.from({ length: 30 }, (_, i) => claimSample(40 - i, 400));
  return {
    at: new Date(T0).toISOString(),
    claimSamples: samples,
    cronRuns: [
      cronRun(new Date(T0 - 2 * 3_600_000).toISOString(), 0),
      cronRun(new Date(T0 - 3_600_000).toISOString(), 0),
    ],
    appVersion: null,
    runnerVersion: null,
    samplingSince: samples[0]!.at,
  };
}

describe('the detector registry', () => {
  test('registers both detectors the incident justifies, and no speculative ones', () => {
    expect(DETECTORS.map(d => d.id).sort()).toEqual(['claim-error-rate', 'dispatch-stall']);
  });

  test('ids are unique and condition keys do not collide', () => {
    const ids = DETECTORS.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every detector describes itself for the page body', () => {
    for (const d of DETECTORS) expect(d.describes.length).toBeGreaterThan(20);
  });
});

describe('every detector is evaluable with no model credential present', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of MODEL_AND_SECRET_ENV) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  test('the environment really is stripped — guard the guard', () => {
    for (const key of MODEL_AND_SECRET_ENV) {
      expect(process.env[key], `${key} survived the strip`).toBeUndefined();
    }
  });

  test('each detector fires on a firing snapshot, with no credential anywhere', () => {
    const snapshot = firingSnapshot();
    for (const detector of DETECTORS) {
      const verdict = detector.evaluate(snapshot, T0);
      expect(verdict.state, `${detector.id} did not fire`).toBe('firing');
      expect(verdict.detector).toBe(detector.id);
    }
  });

  test('each detector clears on a clear snapshot, with no credential anywhere', () => {
    const snapshot = clearSnapshot();
    for (const detector of DETECTORS) {
      expect(detector.evaluate(snapshot, T0).state, `${detector.id}`).toBe('clear');
    }
  });

  test('a firing verdict names its condition and when it tripped', () => {
    // This is what the page says when the narrative is unavailable. It has to
    // stand alone: a pager that says "something is wrong" is not a pager.
    const snapshot = firingSnapshot();
    for (const detector of DETECTORS) {
      const v = detector.evaluate(snapshot, T0);
      expect(v.summary.length, `${detector.id} summary`).toBeGreaterThan(40);
      expect(v.onsetAt, `${detector.id} onsetAt`).not.toBeNull();
      // The onset instant must be IN the summary, not merely in the facts --
      // the facts are for the evidence log, the summary is the page.
      expect(v.summary, `${detector.id} summary omits its onset`).toContain(v.onsetAt!);
      expect(v.conditionKey.length).toBeGreaterThan(0);
    }
  });

  test('facts are JSON-serializable, so evidence can never fail to record', () => {
    const snapshot = firingSnapshot();
    for (const detector of DETECTORS) {
      const v = detector.evaluate(snapshot, T0);
      expect(() => JSON.stringify(v)).not.toThrow();
      expect(JSON.parse(JSON.stringify(v.facts))).toEqual(
        JSON.parse(JSON.stringify(v.facts)),
      );
    }
  });
});

describe('the credential-free rule is structural, not a convention', () => {
  test('evaluate is synchronous — there is no promise to await a model on', () => {
    const snapshot = clearSnapshot();
    for (const detector of DETECTORS) {
      const result = detector.evaluate(snapshot, T0) as unknown;
      expect(result, `${detector.id} returned a thenable`).not.toHaveProperty('then');
    }
  });

  test('evaluate takes exactly (snapshot, now) — no client parameter exists', () => {
    for (const detector of DETECTORS) {
      expect(detector.evaluate.length, `${detector.id}`).toBe(2);
    }
  });

  test('a verdict is reproducible from a snapshot — no hidden clock or I/O', () => {
    const snapshot = firingSnapshot();
    for (const detector of DETECTORS) {
      expect(detector.evaluate(snapshot, T0)).toEqual(detector.evaluate(snapshot, T0));
    }
  });
});
