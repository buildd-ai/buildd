import { describe, it, expect, beforeEach } from 'bun:test';
import {
  measurementFor,
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
    expect(ask(JEV, [])).toEqual({ measured: true, threshold: null, reason: 'jev_default' });
  });

  it('a model with no row is not measured: it records only', () => {
    expect(ask('clef', [])).toMatchObject({ measured: false, threshold: null, reason: 'not_measured' });
  });

  it('Clef acts once a row exists, at that row’s threshold', () => {
    expect(ask('clef', [row()])).toEqual({ measured: true, threshold: 0.62, reason: 'measured' });
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
    expect(ask('clef', [row()], 'p-v4')).toEqual({ measured: false, threshold: null, reason: 'fingerprint_changed' });
  });

  it('a retired row records only', () => {
    expect(ask('clef', [row({ status: 'retired' })])).toMatchObject({ measured: false, reason: 'retired' });
  });

  it('Jev with an active row uses the measured threshold; a stale or retired Jev row falls back to today', () => {
    expect(ask(JEV, [row({ model: 'typesafe/jev-1.13', threshold: 0.7 })])).toEqual({ measured: true, threshold: 0.7, reason: 'measured' });
    expect(ask(JEV, [row({ model: 'typesafe/jev-1.13', threshold: 0.7 })], 'p-v4')).toEqual({ measured: true, threshold: null, reason: 'jev_default' });
    expect(ask(JEV, [row({ model: 'typesafe/jev-1.13', status: 'retired' })])).toEqual({ measured: true, threshold: null, reason: 'jev_default' });
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
