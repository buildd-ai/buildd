import { describe, expect, it } from 'bun:test';
import { applyDecisionPolicy, choice, gateAnswer, noul, score, type DecideResult } from './index';

const C = choice('Pick', { a: 'A', b: 'B' });
const cAnswer = (confidence: number) => ({ type: 'choice' as const, choice: 'a' as const, probabilities: { a: confidence, b: 1 - confidence }, confidence });
const N = noul('Yes?');
const S = score('Level', ['low', 'mid', 'high']);

describe('modes', () => {
  it('shadow never applies, even at confidence 1', () => {
    expect(gateAnswer(C, cAnswer(1), { mode: 'shadow', minConfidence: 0.5 })).toMatchObject({ status: 'suggested', reason: 'shadow', value: 'a' });
  });

  it('gated applies at or above the threshold only', () => {
    expect(gateAnswer(C, cAnswer(0.9), { mode: 'gated', minConfidence: 0.9 })).toMatchObject({ status: 'applied', value: 'a', confidence: 0.9 });
    expect(gateAnswer(C, cAnswer(0.89), { mode: 'gated', minConfidence: 0.9 })).toMatchObject({ status: 'suggested', reason: 'below_threshold' });
  });

  it('gated without a threshold never applies (defineDecision refuses it up front)', () => {
    expect(gateAnswer(C, cAnswer(1), { mode: 'gated', minConfidence: null }).status).toBe('suggested');
  });

  it('live applies everything with no threshold, and respects one if set', () => {
    expect(gateAnswer(C, cAnswer(0.3), { mode: 'live', minConfidence: null }).status).toBe('applied');
    expect(gateAnswer(C, cAnswer(0.3), { mode: 'live', minConfidence: 0.6 }).status).toBe('suggested');
  });
});

describe('noul gating', () => {
  const at = (p: number) => gateAnswer(N, { type: 'noul', noul: p }, { mode: 'live', minConfidence: 0.6 });
  it('is symmetric: yes at p >= t, no at p <= 1 - t, suggested between', () => {
    expect(at(0.7)).toMatchObject({ status: 'applied', value: true });
    expect(at(0.6)).toMatchObject({ status: 'applied', value: true });
    expect(at(0.3)).toMatchObject({ status: 'applied', value: false });
    expect(at(0.55)).toMatchObject({ status: 'suggested', value: true });
    expect(at(0.5).status).toBe('suggested');
  });

  it('reproduces Cue\'s add-only hold: hold only when p >= 0.6', () => {
    const holds = (p: number) => { const o = at(p); return o.status === 'applied' && o.value === true; };
    expect([0.59, 0.6, 0.9, 0.1].map(holds)).toEqual([false, true, true, false]);
  });
});

describe('score gating', () => {
  it('uses the score as value and the provider confidence', () => {
    const a = { type: 'score' as const, score: 1.8, legend: {}, probabilities: {}, confidence: 0.92 };
    expect(gateAnswer(S, a, { mode: 'gated', minConfidence: 0.9 })).toMatchObject({ status: 'applied', value: 1.8 });
  });
});

describe('applyDecisionPolicy', () => {
  const questions = { c: C, n: N };
  it('gates each question under its own policy', () => {
    const result: DecideResult<typeof questions> = {
      ok: true,
      answers: { c: cAnswer(0.95), n: { type: 'noul', noul: 0.9 } },
      model: 'm', usage: { inputTokens: 1, outputTokens: 0, costUsd: null }, latencyMs: 1, attempts: 1,
    };
    const out = applyDecisionPolicy(questions, result, name =>
      name === 'c' ? { mode: 'gated', minConfidence: 0.99 } : { mode: 'live', minConfidence: 0.6 });
    expect(out.c.status).toBe('suggested');
    expect(out.n.status).toBe('applied');
  });

  it('skips every question with the call error', () => {
    const out = applyDecisionPolicy(questions, { ok: false, error: { kind: 'timeout', timeoutMs: 5 }, latencyMs: 5, attempts: 1 },
      () => ({ mode: 'live', minConfidence: null }));
    expect(out.c).toEqual({ status: 'skipped', reason: 'error', error: { kind: 'timeout', timeoutMs: 5 } });
    expect(out.n.status).toBe('skipped');
  });
});
