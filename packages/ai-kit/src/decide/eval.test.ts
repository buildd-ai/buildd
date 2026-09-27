import { describe, expect, it } from 'bun:test';
import { choice, defineDecision, idParity, noul, runDecisionEval, summarizeDecisionEval, type EvalPrediction } from './index';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A 200 body in the Decisions API's shape. */
function okBody(answers: Record<string, unknown>, cost: number | undefined = 0.00002) {
  return {
    model: 'typesafe/jev-1.13-20260917',
    answers,
    usage: { input_tokens: 400, output_tokens: 50, ...(cost === undefined ? {} : { cost }) },
  };
}

const noSleep = () => Promise.resolve();

const p = (id: number, truth: string, pred: string | null, confidence: number | null, extra: Partial<EvalPrediction> = {}): EvalPrediction =>
  ({ id, truth, pred, confidence, costUsd: 0.0002, latencyMs: 200, ...extra });

describe('summarizeDecisionEval', () => {
  const rows = [
    p(1, 'a', 'a', 0.99),
    p(2, 'a', 'a', 0.95),
    p(3, 'b', 'a', 0.92),
    p(4, 'b', 'b', 0.6),
    p(5, 'a', null, null, { error: 'timeout', costUsd: 0 }),
  ];
  const s = summarizeDecisionEval(rows, { thresholds: [0.5, 0.9, 0.95], applyAt: 0.9 });

  it('reports accuracy over answered rows and counts errors separately', () => {
    expect(s.n).toBe(5);
    expect(s.errors).toBe(1);
    expect(s.accuracy).toEqual({ n: 4, correct: 3, rate: 0.75 });
  });

  it('reports coverage and accuracy at each threshold', () => {
    expect(s.coverage).toEqual([
      { threshold: 0.5, coverage: 1, accuracy: { n: 4, correct: 3, rate: 0.75 } },
      { threshold: 0.9, coverage: 0.75, accuracy: { n: 3, correct: 2, rate: 2 / 3 } },
      { threshold: 0.95, coverage: 0.5, accuracy: { n: 2, correct: 2, rate: 1 } },
    ]);
  });

  it('reports per-label precision/recall at the apply threshold, confusions and cost', () => {
    expect(s.perLabel.find(l => l.label === 'a')).toEqual({ label: 'a', support: 2, predicted: 3, precision: 2 / 3, recall: 1 });
    expect(s.confusions).toEqual([{ truth: 'b', pred: 'a', count: 1, ids: [3] }]);
    expect(s.costPer1k).toBeCloseTo(0.2, 6);
    expect(s.latencyMs.p50).toBe(200);
  });

  it('handles no rows', () => {
    const empty = summarizeDecisionEval([]);
    expect(empty.accuracy.rate).toBeNull();
    expect(empty.costPer1k).toBeNull();
  });
});

describe('idParity', () => {
  it('splits numbers by value and strings stably', () => {
    expect([1, 2, 3, 4].map(idParity)).toEqual(['odd', 'even', 'odd', 'even']);
    expect(idParity('row-17')).toBe(idParity('row-17'));
  });
});

describe('runDecisionEval', () => {
  const decision = defineDecision({
    id: 'test.notable',
    promptVersion: '2026-09-27.a',
    questions: { verdict: choice('Routine or not?', { routine: 'Everyday', unusual: 'Check it' }) },
    mode: 'gated',
    minConfidence: 0.9,
  });
  const rows = [
    { id: 1, text: 'KROGER', label: 'routine' },
    { id: 2, text: 'OVERDRAFT FEE', label: 'unusual' },
    { id: 3, text: 'COSTCO', label: 'routine' },
    { id: 4, text: 'WEIRD LLC', label: 'unusual' },
  ];
  // A fake Jev: calls everything routine, confidently.
  const fetch = async (_u: string, init: RequestInit = {}) => {
    const state = JSON.parse(init.body as string).state as { text: string };
    const unusual = state.text.includes('FEE');
    return jsonResponse(okBody({
      verdict: { type: 'choice', choice: unusual ? 'unusual' : 'routine', probabilities: {}, confidence: unusual ? 0.97 : 0.93 },
    }, 0.0001));
  };

  it('runs the decision over labelled rows and scores it, with even/odd halves', async () => {
    const report = await runDecisionEval({
      decision, rows, split: 'even-odd',
      stateOf: r => ({ text: r.text }), labelOf: r => r.label, idOf: r => r.id,
      run: { apiKey: 'k', fetch, sleep: noSleep },
    });
    expect(report.question).toBe('verdict');
    expect(report.version).toBe(decision.version);
    expect(report.fingerprint).toBe(decision.fingerprint);
    expect(report.summary.accuracy).toEqual({ n: 4, correct: 3, rate: 0.75 });
    expect(report.summary.applyAt).toBe(0.9);
    expect(report.halves!.even.accuracy).toEqual({ n: 2, correct: 1, rate: 0.5 });
    expect(report.halves!.odd.accuracy).toEqual({ n: 2, correct: 2, rate: 1 });
    expect(report.summary.costUsd).toBeCloseTo(0.0004, 9);
  });

  it('scores only one half when asked, and records call errors', async () => {
    const report = await runDecisionEval({
      decision, rows, split: 'odd',
      stateOf: r => ({ text: r.text }), labelOf: r => r.label, idOf: r => r.id,
      run: { apiKey: 'k', fetch: async () => jsonResponse({}, 400), sleep: noSleep },
    });
    expect(report.predictions.map(x => x.id)).toEqual([1, 3]);
    expect(report.summary.errors).toBe(2);
    expect(report.predictions[0].error).toBe('provider_error');
  });

  it('scores a noul against boolean labels', async () => {
    const d = defineDecision({ id: 'test.bug', promptVersion: 'v1', questions: { bug: noul('Bug?') }, mode: 'shadow' });
    const report = await runDecisionEval({
      decision: d, rows: [{ id: 1, bug: true }, { id: 2, bug: false }],
      stateOf: r => ({ id: r.id }), labelOf: r => r.bug, idOf: r => r.id,
      run: { apiKey: 'k', sleep: noSleep, fetch: async () => jsonResponse(okBody({ bug: { type: 'noul', noul: 0.8 } })) },
    });
    expect(report.summary.accuracy).toEqual({ n: 2, correct: 1, rate: 0.5 });
    expect(report.predictions[0].confidence).toBe(0.8);
    expect(report.summary.applyAt).toBeNull();
  });

  it('requires naming the question when there are several', async () => {
    const d = defineDecision({ id: 'test.two', promptVersion: 'v1', questions: { a: noul('A?'), b: noul('B?') }, mode: 'shadow' });
    await expect(runDecisionEval({
      decision: d, rows: [], stateOf: () => 'x', labelOf: () => true, idOf: () => 1, run: { apiKey: 'k' },
    })).rejects.toThrow(/name the question/);
  });
});
