import { describe, expect, it } from 'bun:test';
import { isCalibration } from '@buildd/core/decision-model-measurements';
import {
  CONFIDENCE_SOURCES,
  crossFitCalibratedTopP,
  deriveThreshold,
  fitIsotonic,
  percentile,
  reliability,
  scoreModel,
  sweep,
  wilsonLower,
  type ScoredCase,
} from './calibration';

/** n cases at one signal value, `right` of them correct. */
function at(value: number, n: number, right: number, extra: Partial<ScoredCase> = {}): ScoredCase[] {
  return Array.from({ length: n }, (_, i) => ({
    label: i < right ? 'gold' : 'other',
    correct: i < right,
    confidence: value,
    topP: value,
    ...extra,
  }));
}

describe('wilsonLower', () => {
  it('is 0 with nothing observed', () => {
    expect(wilsonLower(0, 0)).toBe(0);
  });

  it('sits below the point estimate, and closer to it as n grows', () => {
    const small = wilsonLower(9, 10);
    const large = wilsonLower(900, 1000);
    expect(small).toBeLessThan(0.9);
    expect(large).toBeLessThan(0.9);
    expect(large).toBeGreaterThan(small);
    // 95% Wilson lower bound of 9/10 is ~0.596; 900/1000 is ~0.880.
    expect(small).toBeCloseTo(0.596, 2);
    expect(large).toBeCloseTo(0.880, 2);
  });

  it('is below 1 even for a perfect record', () => {
    expect(wilsonLower(20, 20)).toBeLessThan(1);
    expect(wilsonLower(20, 20)).toBeCloseTo(0.839, 2);
  });
});

describe('reliability', () => {
  it('a perfectly calibrated signal has ECE 0', () => {
    const cases = [...at(0.25, 40, 10), ...at(0.75, 40, 30)];
    const r = reliability(cases, 'confidence');
    expect(r.n).toBe(80);
    expect(r.ece).toBeCloseTo(0, 10);
  });

  it('ECE is the count-weighted gap between mean signal and accuracy per bin', () => {
    // Bin [0.9,1.0]: 50 cases at 0.95, 25 right (gap 0.45). Bin [0.5,0.6): 50 at 0.55, 50 right (gap 0.45).
    const cases = [...at(0.95, 50, 25), ...at(0.55, 50, 50)];
    const r = reliability(cases, 'confidence');
    expect(r.ece).toBeCloseTo(0.45, 6);
    const top = r.bins.find(b => b.lo === 0.9)!;
    expect(top.n).toBe(50);
    expect(top.meanSignal).toBeCloseTo(0.95, 6);
    expect(top.accuracy).toBeCloseTo(0.5, 6);
  });

  it('puts 1.0 in the last bin and skips cases without the signal or without gold', () => {
    const cases: ScoredCase[] = [
      { label: 'a', correct: true, confidence: 1, topP: null },
      { label: 'a', correct: null, confidence: 0.5, topP: 0.5 },
      { label: null, correct: false, confidence: null, topP: null },
    ];
    const conf = reliability(cases, 'confidence');
    expect(conf.n).toBe(1);
    expect(conf.bins[conf.bins.length - 1].n).toBe(1);
    expect(reliability(cases, 'top_p').n).toBe(0);
    expect(reliability(cases, 'top_p').ece).toBeNull();
  });
});

describe('sweep', () => {
  it('reports precision, coverage and the Wilson bound at each threshold', () => {
    const cases = [...at(0.95, 20, 19), ...at(0.6, 20, 10)];
    const rows = sweep(cases, 'confidence', [0, 0.9]);
    expect(rows[0]).toMatchObject({ threshold: 0, covered: 40, correct: 29 });
    expect(rows[0].coverage).toBeCloseTo(1, 6);
    expect(rows[0].precision).toBeCloseTo(29 / 40, 6);
    expect(rows[1]).toMatchObject({ threshold: 0.9, covered: 20, correct: 19 });
    expect(rows[1].coverage).toBeCloseTo(0.5, 6);
    expect(rows[1].wilsonLower).toBeCloseTo(wilsonLower(19, 20), 10);
  });

  it('counts only labelled cases: coverage is over cases with gold', () => {
    const cases = [...at(0.95, 10, 10), ...at(0.95, 10, 0, { correct: null })];
    const [row] = sweep(cases, 'confidence', [0.9]);
    expect(row.covered).toBe(10);
    expect(row.coverage).toBeCloseTo(1, 6);
  });

  it('an errored case (no label) counts against coverage, never as covered', () => {
    const cases: ScoredCase[] = [...at(0.95, 10, 10), { label: null, correct: false, confidence: null, topP: null }];
    const [row] = sweep(cases, 'confidence', [0]);
    expect(row.covered).toBe(10);
    expect(row.coverage).toBeCloseTo(10 / 11, 6);
  });
});

describe('deriveThreshold', () => {
  const opts = { target: 0.9, minLabelled: 50 };

  it('picks the lowest threshold whose Wilson lower bound clears the bar', () => {
    // 0.95 bucket: 200 cases, 196 right (lower ~0.95). 0.75 bucket: 200, 170 right.
    const cases = [...at(0.95, 200, 196), ...at(0.75, 200, 170)];
    const d = deriveThreshold(cases, 'confidence', { ...opts, ruleAccuracy: null });
    // At 0.75 the pooled precision is 366/400 = 0.915 but its lower bound is ~0.884: not enough.
    expect(d.threshold).toBe(0.8);
    expect(d.wilsonLower!).toBeGreaterThanOrEqual(0.9);
    expect(d.reason).toBeNull();
  });

  it('compares on the lower bound, not the point estimate', () => {
    // 60 of 64 = 0.9375 precision, but the lower bound (~0.85) is below 0.9.
    const cases = [...at(0.95, 64, 60), ...at(0.2, 40, 0)];
    const d = deriveThreshold(cases, 'confidence', { ...opts, ruleAccuracy: null });
    expect(d.threshold).toBeNull();
    expect(d.reason).toBe('no_threshold_meets_bar');
  });

  it('raises the bar to the rule accuracy when the rule is better than the target', () => {
    const cases = [...at(0.95, 300, 285), ...at(0.5, 100, 50)];
    // 285/300 = 0.95, lower bound ~0.92: clears 0.9, not 0.93.
    expect(deriveThreshold(cases, 'confidence', { ...opts, ruleAccuracy: 0.85 }).threshold).not.toBeNull();
    const d = deriveThreshold(cases, 'confidence', { ...opts, ruleAccuracy: 0.93 });
    expect(d.threshold).toBeNull();
    expect(d.bar).toBe(0.93);
  });

  it('is null with a reason under the kind minimum of labelled cases', () => {
    const d = deriveThreshold(at(0.99, 30, 30), 'confidence', { ...opts, ruleAccuracy: null });
    expect(d.threshold).toBeNull();
    expect(d.reason).toBe('too_few_labelled');
    expect(d.labelled).toBe(30);
  });

  it('is null with a reason when the model gave no such signal', () => {
    const cases = at(0.99, 80, 80).map(c => ({ ...c, topP: null }));
    const d = deriveThreshold(cases, 'top_p', { ...opts, ruleAccuracy: null });
    expect(d.threshold).toBeNull();
    expect(d.reason).toBe('no_signal');
  });
});

describe('scoreModel', () => {
  it('a model whose confidence is compressed but whose top p is calibrated gets a low top-p threshold', () => {
    // Clef-like: the confidence field never passes ~0.45, right or wrong; the top p carries the signal.
    const cases: ScoredCase[] = [
      ...Array.from({ length: 150 }, (_, i) => ({ label: i < 147 ? 'gold' : 'other', correct: i < 147, confidence: 0.42, topP: 0.97 })),
      ...Array.from({ length: 100 }, (_, i) => ({ label: i < 60 ? 'gold' : 'other', correct: i < 60, confidence: 0.4, topP: 0.6 })),
      ...Array.from({ length: 50 }, (_, i) => ({ label: i < 20 ? 'gold' : 'other', correct: i < 20, confidence: 0.38, topP: 0.4 })),
    ];
    const s = scoreModel(cases, { target: 0.9, minLabelled: 50, ruleAccuracy: 0.5, thresholds: [0, 0.3, 0.5, 0.7, 0.9] });
    expect(s.thresholds.confidence.threshold).toBeNull();
    expect(s.thresholds.top_p.threshold).toBe(0.7);
    expect(s.derived).toMatchObject({ source: 'top_p', threshold: 0.7 });
    expect(s.calibration.top_p.ece!).toBeLessThan(s.calibration.confidence.ece!);
  });

  it('a calibrated model whose two signals agree reads its own confidence', () => {
    const cases = [...at(0.95, 200, 196), ...at(0.6, 100, 60)];
    const s = scoreModel(cases, { target: 0.9, minLabelled: 50, ruleAccuracy: null, thresholds: [0, 0.5, 0.9] });
    expect(s.derived).toMatchObject({ source: 'confidence', threshold: 0.9 });
  });

  it('derived is null with every source reason when nothing qualifies', () => {
    const s = scoreModel(at(0.95, 20, 20), { target: 0.9, minLabelled: 50, ruleAccuracy: null });
    expect(s.derived).toBeNull();
    expect(s.derivedReason).toBe('too_few_labelled');
  });

  it('accuracy counts an error as wrong; rule accuracy and agreement only over cases that have them', () => {
    const cases: ScoredCase[] = [
      { label: 'a', correct: true, confidence: 0.9, topP: 0.9, ruleCorrect: false, prodLabel: 'a' },
      { label: 'b', correct: false, confidence: 0.9, topP: 0.9, ruleCorrect: true, prodLabel: 'a' },
      { label: null, correct: false, confidence: null, topP: null, ruleCorrect: true, prodLabel: 'a' },
      { label: 'a', correct: null, confidence: 0.9, topP: 0.9 },
    ];
    const s = scoreModel(cases, { target: 0.9, minLabelled: 1, ruleAccuracy: null });
    expect(s.n).toBe(4);
    expect(s.labelled).toBe(3);
    expect(s.answered).toBe(3);
    expect(s.accuracy).toBeCloseTo(1 / 3, 6);
    // Rule accuracy is computed on the same labelled cases.
    expect(s.ruleAccuracy).toBeCloseTo(2 / 3, 6);
    // Agreement: both answered, same label, over cases where the production model answered too.
    expect(s.agreement).toBeCloseTo(1 / 2, 6);
  });
});

describe('percentile', () => {
  it('nearest-rank p50 and p95', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 0.5)).toBe(50);
    expect(percentile(xs, 0.95)).toBe(95);
    expect(percentile([], 0.5)).toBeNull();
  });
});

it('names every confidence source a measurement can store', () => {
  expect([...CONFIDENCE_SOURCES]).toEqual(['confidence', 'top_p', 'margin', 'calibrated_top_p']);
});

describe('fitIsotonic', () => {
  it('pools adjacent violators into a non-decreasing step', () => {
    const fit = fitIsotonic([
      { x: 0.2, correct: true }, { x: 0.4, correct: false }, { x: 0.6, correct: true }, { x: 0.8, correct: true },
    ]);
    expect(fit).toEqual({ x: [0.2, 0.4, 0.6, 0.8], y: [0.5, 0.5, 1, 1] });
    expect(isCalibration(fit)).toBe(true);
  });

  it('averages repeated points into one block', () => {
    const fit = fitIsotonic([
      { x: 0.3, correct: false }, { x: 0.3, correct: true }, { x: 0.3, correct: false }, { x: 0.9, correct: true },
    ]);
    expect(fit!.x).toEqual([0.3, 0.9]);
    expect(fit!.y[0]).toBeCloseTo(1 / 3, 9);
    expect(fit!.y[1]).toBe(1);
  });

  it('is null with fewer than two distinct points', () => {
    expect(fitIsotonic([])).toBeNull();
    expect(fitIsotonic([{ x: 0.5, correct: true }, { x: 0.5, correct: false }])).toBeNull();
  });

  it('stays a storable calibration on many distinct points', () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({ x: i / 999, correct: i % 3 !== 0 && i > 300 }));
    const fit = fitIsotonic(points);
    expect(isCalibration(fit)).toBe(true);
    expect(fit!.x[0]).toBe(0);
    expect(fit!.x[fit!.x.length - 1]).toBe(1);
  });
});

describe('crossFitCalibratedTopP', () => {
  it('maps each case through the fit of the other half, never its own', () => {
    // Even cases: right at 0.7, wrong at 0.3 (a clean increasing fit).
    // Odd cases: right at 0.3, wrong at 0.7 (pooled flat at 0.5).
    const cases: ScoredCase[] = Array.from({ length: 40 }, (_, i) => {
      const r = i % 4;
      const topP = r === 0 || r === 3 ? 0.7 : 0.3;
      const correct = r === 0 || r === 1;
      return { label: correct ? 'gold' : 'other', correct, confidence: 0.5, topP };
    });
    const { values, calibration } = crossFitCalibratedTopP(cases);
    values.forEach((v, i) => {
      if (i % 2 === 0) expect(v).toBe(0.5);
      else expect(v).toBe(cases[i].topP === 0.7 ? 1 : 0);
    });
    // What is stored is fitted on every labelled case.
    expect(calibration).toEqual({ x: [0.3, 0.7], y: [0.5, 0.5] });
  });

  it('gives no value to cases without top p or gold, and none at all when a half cannot be fitted', () => {
    const cases: ScoredCase[] = [
      { label: 'gold', correct: true, confidence: 0.5, topP: 0.9 },
      { label: 'gold', correct: true, confidence: 0.5, topP: 0.9 },
      { label: 'gold', correct: null, confidence: 0.5, topP: 0.9 },
    ];
    const out = crossFitCalibratedTopP(cases);
    expect(out.values).toEqual([null, null, null]);
    expect(out.calibration).toBeNull();
  });
});

describe('scoreModel on margin and calibrated top p', () => {
  it('derives a margin threshold on a set where confidence and top p are flat', () => {
    // Every answer says 0.5 confidence and 0.6 top p; only the gap to the runner-up separates right from wrong.
    const cases: ScoredCase[] = [
      ...Array.from({ length: 120 }, () => ({ label: 'gold', correct: true, confidence: 0.5, topP: 0.6, margin: 0.5 })),
      ...Array.from({ length: 60 }, () => ({ label: 'other', correct: false, confidence: 0.5, topP: 0.6, margin: 0.05 })),
    ];
    const s = scoreModel(cases, { target: 0.9, minLabelled: 50, ruleAccuracy: null });
    expect(s.thresholds.confidence.threshold).toBeNull();
    expect(s.thresholds.top_p.threshold).toBeNull();
    expect(s.thresholds.margin).toMatchObject({ threshold: 0.1, reason: null });
    expect(s.derived).toMatchObject({ source: 'margin', threshold: 0.1, calibration: null });
    expect(s.derived!.coverage).toBeCloseTo(120 / 180, 9);
    expect(s.sweep.margin.length).toBe(s.sweep.confidence.length);
  });

  it('margin is no_signal when answers carry no probabilities', () => {
    const s = scoreModel(at(0.95, 80, 80), { target: 0.9, minLabelled: 50, ruleAccuracy: null });
    expect(s.thresholds.margin.reason).toBe('no_signal');
  });

  it('calibrated top p spreads a compressed top p so a threshold qualifies, and carries its breakpoints', () => {
    // Right answers at top p 0.43, wrong at 0.41: no sweep step between them, so raw top p cannot separate them.
    const cases: ScoredCase[] = Array.from({ length: 130 }, (_, i) => (
      i % 3 === 2
        ? { label: 'other', correct: false, confidence: 0.5, topP: 0.41 }
        : { label: 'gold', correct: true, confidence: 0.5, topP: 0.43 }));
    const s = scoreModel(cases, { target: 0.9, minLabelled: 50, ruleAccuracy: null });
    expect(s.thresholds.top_p.threshold).toBeNull();
    expect(s.thresholds.calibrated_top_p.threshold).not.toBeNull();
    expect(s.derived).toMatchObject({ source: 'calibrated_top_p' });
    expect(s.derived!.calibration).toEqual({ x: [0.41, 0.43], y: [0, 1] });
    expect(isCalibration(s.derived!.calibration)).toBe(true);
  });

  it('a coverage tie prefers top p over margin, the same information on two labels', () => {
    // Right at top p 0.97 (margin 0.94), wrong at 0.55 (margin 0.1): both signals cover the same right answers.
    const cases: ScoredCase[] = [
      ...Array.from({ length: 90 }, () => ({ label: 'gold', correct: true, confidence: 0.4, topP: 0.97, margin: 0.94 })),
      ...Array.from({ length: 30 }, () => ({ label: 'other', correct: false, confidence: 0.4, topP: 0.55, margin: 0.1 })),
    ];
    const s = scoreModel(cases, { target: 0.9, minLabelled: 50, ruleAccuracy: null });
    expect(s.thresholds.margin.coverage).toBe(s.thresholds.top_p.coverage);
    expect(s.derived).toMatchObject({ source: 'top_p', calibration: null });
  });

  it('a coverage tie prefers the signal that needs no stored breakpoints', () => {
    const cases = [...at(0.95, 200, 196), ...at(0.3, 100, 40)];
    const s = scoreModel(cases, { target: 0.9, minLabelled: 50, ruleAccuracy: null });
    expect(s.thresholds.calibrated_top_p.coverage).toBe(s.thresholds.top_p.coverage);
    expect(s.derived!.source).not.toBe('calibrated_top_p');
    expect(s.derived!.calibration).toBeNull();
  });
});
