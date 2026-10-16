import { describe, it, expect, beforeEach } from 'bun:test';
import {
  measurementFor,
  measuredSignal,
  calibrate,
  gateOnMeasurement,
  planMeasurementWrite,
  resolveModelMeasurement,
  clearDecisionModelMeasurementCache,
  type StoredMeasurement,
} from '../decision-model-measurements';

const JEV = 'typesafe/jev-1.13-20260917';
const FP = 'p-v3';

const row = (over: Partial<StoredMeasurement> = {}): StoredMeasurement => ({
  kind: 'buildd.example',
  model: 'clef',
  threshold: 0.62,
  precisionLower: 0.95,
  coverage: 0.41,
  n: 120,
  evalRunId: 'run-1',
  measuredFingerprint: FP,
  status: 'active',
  setByAccountId: 'acct-owner',
  setAt: new Date('2026-01-02T00:00:00Z'),
  reason: null,
  ...over,
});

const ask = (model: string, rows: StoredMeasurement[], fingerprint = FP) =>
  measurementFor(rows, { kind: 'buildd.example', answeringModel: model, fingerprint });

describe('measurementFor', () => {
  it('Jev with no row keeps today: measured, no threshold of its own', () => {
    expect(ask(JEV, [])).toEqual({ measured: true, threshold: null, reason: 'jev_default', confidenceSource: 'confidence', calibration: null, labelThresholds: null });
  });

  it('a model with no row is not measured: it records only', () => {
    expect(ask('clef', [])).toMatchObject({ measured: false, threshold: null, reason: 'not_measured' });
  });

  it('Clef acts once a row exists, at that row’s threshold', () => {
    expect(ask('clef', [row()])).toEqual({ measured: true, threshold: 0.62, reason: 'measured', confidenceSource: 'confidence', calibration: null, labelThresholds: null });
    // The Workers AI path form of the same model matches the row.
    expect(ask('@cf/cloudflare/clef', [row()])).toMatchObject({ measured: true, threshold: 0.62 });
  });

  it('a Clef row never covers Clef Flash, and the reverse', () => {
    expect(ask('clef-flash', [row()])).toMatchObject({ measured: false, reason: 'not_measured' });
    expect(ask('clef', [row({ model: 'clef-flash', threshold: 0.27 })])).toMatchObject({ measured: false });
    expect(ask('clef-flash', [row({ model: 'clef-flash', threshold: 0.27 })])).toMatchObject({ measured: true, threshold: 0.27 });
  });

  it('a dated model id matches a row for its undated name', () => {
    expect(ask('acme/judge-2-20260101', [row({ model: 'acme/judge-2' })])).toMatchObject({ measured: true });
    expect(ask('acme/judge-20', [row({ model: 'acme/judge-2' })])).toMatchObject({ measured: false });
  });

  it('a fingerprint change retires the row: the model records again, and says why', () => {
    expect(ask('clef', [row()], 'p-v4')).toEqual({ measured: false, threshold: null, reason: 'fingerprint_changed', confidenceSource: 'confidence', calibration: null, labelThresholds: null });
  });

  it('a retired row records only', () => {
    expect(ask('clef', [row({ status: 'retired' })])).toMatchObject({ measured: false, reason: 'retired' });
  });

  it('Jev with an active row uses the measured threshold; a stale or retired Jev row falls back to today', () => {
    expect(ask(JEV, [row({ model: 'typesafe/jev-1.13', threshold: 0.7 })])).toEqual({ measured: true, threshold: 0.7, reason: 'measured', confidenceSource: 'confidence', calibration: null, labelThresholds: null });
    expect(ask(JEV, [row({ model: 'typesafe/jev-1.13', threshold: 0.7 })], 'p-v4')).toEqual({ measured: true, threshold: null, reason: 'jev_default', confidenceSource: 'confidence', calibration: null, labelThresholds: null });
    expect(ask(JEV, [row({ model: 'typesafe/jev-1.13', status: 'retired' })])).toEqual({ measured: true, threshold: null, reason: 'jev_default', confidenceSource: 'confidence', calibration: null, labelThresholds: null });
  });

  it('a row for another kind does not count', () => {
    expect(ask('clef', [row({ kind: 'buildd.other' })])).toMatchObject({ measured: false });
  });
});

describe('resolveModelMeasurement', () => {
  beforeEach(() => clearDecisionModelMeasurementCache());

  it('reads the stored rows for the kind', async () => {
    const m = await resolveModelMeasurement(
      { kind: 'buildd.example', answeringModel: 'clef', fingerprint: FP },
      { load: async () => [row()] },
    );
    expect(m).toMatchObject({ measured: true, threshold: 0.62 });
  });

  it('a failed read is no rows: Jev keeps today, others record only', async () => {
    const load = async () => { throw new Error('db down'); };
    expect(await resolveModelMeasurement({ kind: 'buildd.example', answeringModel: JEV, fingerprint: FP }, { load }))
      .toMatchObject({ measured: true, threshold: null });
    expect(await resolveModelMeasurement({ kind: 'buildd.example', answeringModel: 'clef', fingerprint: FP }, { load }))
      .toMatchObject({ measured: false });
  });
});

describe('planMeasurementWrite', () => {
  const good = { kind: 'buildd.example', model: 'clef', threshold: 0.62, precisionLower: 0.95, coverage: 0.41, n: 120, evalRunId: 'run-1', measuredFingerprint: FP };

  it('accepts a measurement and normalizes the Clef id', () => {
    const p = planMeasurementWrite({ ...good, model: '@cf/cloudflare/clef', reason: 'eval run-1' });
    expect(p).toMatchObject({ ok: true, action: 'set', row: { kind: 'buildd.example', model: 'clef', threshold: 0.62, status: 'active', reason: 'eval run-1' } });
  });

  it('accepts a retire', () => {
    expect(planMeasurementWrite({ action: 'retire', kind: 'buildd.example', model: 'clef' })).toMatchObject({ ok: true, action: 'retire', kind: 'buildd.example', model: 'clef' });
  });

  it('refuses out-of-range or missing fields', () => {
    for (const bad of [
      { ...good, threshold: 1.2 },
      { ...good, threshold: -0.1 },
      { ...good, precisionLower: 2 },
      { ...good, coverage: -1 },
      { ...good, n: 0 },
      { ...good, n: 1.5 },
      { ...good, measuredFingerprint: '' },
      { ...good, kind: '' },
      { ...good, model: 'not a model id!' },
      { action: 'retire', kind: 'buildd.example' },
      null,
    ]) {
      expect(planMeasurementWrite(bad)).toMatchObject({ ok: false, status: 400 });
    }
  });
});

// ── Confidence sources ───────────────────────────────────────────────────────

// Clef's own `confidence` is unusable as a signal (it barely moves with the
// probabilities), so the fixtures give it a value that would pass any
// threshold: a source other than 'confidence' must ignore it.
const START = { choice: 'START', confidence: 0.99, probabilities: { START: 0.7, HOLD: 0.3 } };
const HOLD = { choice: 'HOLD', confidence: 0.99, probabilities: { START: 0.2, HOLD: 0.8 } };
const CAL = { x: [0.5, 0.7, 0.9], y: [0.2, 0.6, 0.8] };

describe('measuredSignal', () => {
  it("'confidence' is the provider's confidence, as today", () => {
    expect(measuredSignal('confidence', START, null)).toBe(0.99);
  });

  it("'top_p' is the probability of the chosen label", () => {
    expect(measuredSignal('top_p', START, null)).toBe(0.7);
    expect(measuredSignal('top_p', HOLD, null)).toBe(0.8);
  });

  it("'margin' is top1 minus top2", () => {
    expect(measuredSignal('margin', START, null)).toBeCloseTo(0.4, 10);
    expect(measuredSignal('margin', { choice: 'a', confidence: 0.5, probabilities: { a: 0.5, b: 0.3, c: 0.2 } }, null)).toBeCloseTo(0.2, 10);
    // One label: nothing to be confused with.
    expect(measuredSignal('margin', { choice: 'a', confidence: 1, probabilities: { a: 1 } }, null)).toBe(1);
  });

  it("'calibrated_top_p' maps top p through the stored breakpoints", () => {
    expect(measuredSignal('calibrated_top_p', START, CAL)).toBeCloseTo(0.6, 10);
  });

  it('no probabilities, no signal: a non-confidence source never falls back to confidence', () => {
    const bare = { choice: 'START', confidence: 0.99 };
    expect(measuredSignal('top_p', bare, null)).toBeNull();
    expect(measuredSignal('margin', { ...bare, probabilities: {} }, null)).toBeNull();
    expect(measuredSignal('top_p', { ...bare, probabilities: { HOLD: 1 } }, null)).toBeNull();
    // Calibrated with no breakpoints stored is unusable, not uncalibrated.
    expect(measuredSignal('calibrated_top_p', START, null)).toBeNull();
  });
});

describe('calibrate', () => {
  it('returns the breakpoint value at a breakpoint', () => {
    expect(calibrate(0.5, CAL)).toBe(0.2);
    expect(calibrate(0.7, CAL)).toBe(0.6);
    expect(calibrate(0.9, CAL)).toBe(0.8);
  });

  it('interpolates linearly between breakpoints', () => {
    expect(calibrate(0.6, CAL)).toBeCloseTo(0.4, 10);
    expect(calibrate(0.8, CAL)).toBeCloseTo(0.7, 10);
    expect(calibrate(0.75, CAL)).toBeCloseTo(0.65, 10);
  });

  it('clips outside the measured range to the end values', () => {
    expect(calibrate(0.1, CAL)).toBe(0.2);
    expect(calibrate(1, CAL)).toBe(0.8);
  });

  it('a flat isotonic step (repeated x) takes the higher side, never NaN', () => {
    const step = { x: [0.5, 0.7, 0.7, 0.9], y: [0.1, 0.3, 0.6, 0.9] };
    expect(calibrate(0.7, step)).toBe(0.6);
    expect(Number.isNaN(calibrate(0.7, step))).toBe(false);
  });
});

describe('gateOnMeasurement', () => {
  const clefRow = (over: Partial<StoredMeasurement>) => ask('clef', [row({ kind: 'buildd.example', ...over })]);

  it('an existing row (no source stored) behaves exactly as before: confidence vs threshold', () => {
    const m = clefRow({});
    expect(m.confidenceSource).toBe('confidence');
    expect(gateOnMeasurement(m, { choice: 'x', confidence: 0.62 }, 0.9)).toMatchObject({ acts: true, signal: 0.62, threshold: 0.62 });
    expect(gateOnMeasurement(m, { choice: 'x', confidence: 0.61 }, 0.9)).toMatchObject({ acts: false, reason: 'below_threshold' });
  });

  it("Jev with no row uses the caller's threshold on its confidence", () => {
    const m = ask(JEV, []);
    expect(gateOnMeasurement(m, { choice: 'x', confidence: 0.86 }, 0.85)).toMatchObject({ acts: true, threshold: 0.85 });
    expect(gateOnMeasurement(m, { choice: 'x', confidence: 0.84 }, 0.85)).toMatchObject({ acts: false });
  });

  it('a model not measured never acts', () => {
    expect(gateOnMeasurement(ask('clef', []), START, 0)).toMatchObject({ acts: false, reason: 'not_measured' });
  });

  it("'top_p' compares top p, not Clef's confidence", () => {
    const m = clefRow({ confidenceSource: 'top_p', threshold: 0.75 });
    expect(gateOnMeasurement(m, START, 0.9)).toMatchObject({ acts: false, signal: 0.7, reason: 'below_threshold' });
    expect(gateOnMeasurement(m, HOLD, 0.9)).toMatchObject({ acts: true, signal: 0.8 });
  });

  it("'margin' compares top1 - top2", () => {
    const m = clefRow({ confidenceSource: 'margin', threshold: 0.5 });
    expect(gateOnMeasurement(m, START, 0.9)).toMatchObject({ acts: false });
    expect(gateOnMeasurement(m, HOLD, 0.9)).toMatchObject({ acts: true });
  });

  it("'calibrated_top_p' compares the calibrated value", () => {
    const m = clefRow({ confidenceSource: 'calibrated_top_p', calibration: CAL, threshold: 0.55 });
    expect(gateOnMeasurement(m, START, 0.9)).toMatchObject({ acts: true });
    expect(gateOnMeasurement(m, { ...START, probabilities: { START: 0.65, HOLD: 0.35 } }, 0.9)).toMatchObject({ acts: false });
  });

  it('per-label thresholds: START acts at its own threshold, HOLD never acts (the rule stands)', () => {
    const m = clefRow({ confidenceSource: 'top_p', threshold: 0.99, labelThresholds: { START: 0.65 } });
    expect(gateOnMeasurement(m, START, 0.9)).toMatchObject({ acts: true, signal: 0.7, threshold: 0.65 });
    expect(gateOnMeasurement(m, { ...START, probabilities: { START: 0.6, HOLD: 0.4 } }, 0.9)).toMatchObject({ acts: false, reason: 'below_threshold' });
    // A confident HOLD is not measured to act: it stays the rule's.
    expect(gateOnMeasurement(m, { ...HOLD, probabilities: { START: 0.01, HOLD: 0.99 } }, 0.9)).toMatchObject({ acts: false, threshold: null, reason: 'label_not_measured' });
  });

  it('no usable signal does not act', () => {
    const m = clefRow({ confidenceSource: 'top_p' });
    expect(gateOnMeasurement(m, { choice: 'START', confidence: 0.99 }, 0)).toMatchObject({ acts: false, signal: null, reason: 'no_signal' });
  });
});

describe('planMeasurementWrite: sources, calibration, label thresholds', () => {
  const good = { kind: 'buildd.example', model: 'clef', threshold: 0.65, n: 120, measuredFingerprint: FP };

  it('defaults to confidence with no calibration and no label thresholds', () => {
    expect(planMeasurementWrite(good)).toMatchObject({ ok: true, row: { confidenceSource: 'confidence', calibration: null, labelThresholds: null } });
  });

  it('accepts each source', () => {
    for (const confidenceSource of ['confidence', 'top_p', 'margin'] as const) {
      expect(planMeasurementWrite({ ...good, confidenceSource })).toMatchObject({ ok: true, row: { confidenceSource } });
    }
    expect(planMeasurementWrite({ ...good, confidenceSource: 'calibrated_top_p', calibration: CAL }))
      .toMatchObject({ ok: true, row: { confidenceSource: 'calibrated_top_p', calibration: CAL } });
  });

  it('accepts START-only thresholds', () => {
    expect(planMeasurementWrite({ ...good, confidenceSource: 'top_p', labelThresholds: { START: 0.65 } }))
      .toMatchObject({ ok: true, row: { labelThresholds: { START: 0.65 } } });
  });

  it('refuses a bad source, calibration or label thresholds', () => {
    for (const bad of [
      { ...good, confidenceSource: 'vibes' },
      { ...good, confidenceSource: 'calibrated_top_p' },
      { ...good, confidenceSource: 'top_p', calibration: CAL },
      { ...good, confidenceSource: 'calibrated_top_p', calibration: { x: [0.5], y: [0.5] } },
      { ...good, confidenceSource: 'calibrated_top_p', calibration: { x: [0.5, 0.7], y: [0.5] } },
      { ...good, confidenceSource: 'calibrated_top_p', calibration: { x: [0.7, 0.5], y: [0.2, 0.6] } },
      { ...good, confidenceSource: 'calibrated_top_p', calibration: { x: [0.5, 0.7], y: [0.6, 0.2] } },
      { ...good, confidenceSource: 'calibrated_top_p', calibration: { x: [0.5, 1.7], y: [0.2, 0.6] } },
      { ...good, labelThresholds: {} },
      { ...good, labelThresholds: { START: 1.5 } },
      { ...good, labelThresholds: [0.65] },
    ]) {
      expect(planMeasurementWrite(bad)).toMatchObject({ ok: false, status: 400 });
    }
  });
});
