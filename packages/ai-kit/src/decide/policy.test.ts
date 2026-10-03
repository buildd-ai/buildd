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

// ══ Decision kinds: rule → cheap model → escalation → per-kind fallback ═══════

import {
  decideRoute,
  defineDecisionKind,
  normalizeDecisionFailure,
  runDecisionAttempt,
  runDecisionKind,
  type DecisionInvoker,
  type DecisionRoute,
  type DecisionRuntime,
} from './policy';

type Triage = 'analyse' | 'skip';
interface TriageFeatures { failedTests: number; hardTrigger: boolean }

const triageQuestions = { verdict: choice('Does this session need deep analysis?', { analyse: 'Likely defect', skip: 'Routine' }) };

function triageKind(extra: Partial<Parameters<typeof defineDecisionKind<'test.post_session_triage', TriageFeatures, Triage, typeof triageQuestions>>[0]> = {}) {
  return defineDecisionKind({
    kind: 'test.post_session_triage',
    policyVersion: '2026-10-03.a',
    featureSchemaVersion: 'v1',
    decisions: ['analyse', 'skip'] as const,
    parseFeatures: (input: unknown) => {
      const f = input as Partial<TriageFeatures> | null;
      if (!f || typeof f.failedTests !== 'number' || f.failedTests < 0 || f.failedTests > 10_000 || typeof f.hardTrigger !== 'boolean') {
        return { ok: false, message: 'failedTests must be 0-10000 and hardTrigger a boolean' };
      }
      return { ok: true, features: { failedTests: f.failedTests, hardTrigger: f.hardTrigger } };
    },
    override: f => (f.hardTrigger ? { decision: 'analyse', reasonCode: 'hard_trigger' } : null),
    questions: triageQuestions,
    state: f => ({ failedTests: f.failedTests }),
    interpret: answers => ({ decision: answers.verdict.choice, confidence: answers.verdict.confidence, reasonCode: `model_${answers.verdict.choice}` }),
    minConfidence: 0.8,
    escalation: { minConfidence: 0.7 },
    fallback: (_f, cause) => ({ decision: 'skip', reasonCode: `fallback_${cause}` }),
    ...extra,
  });
}

/** A route whose invoker answers from a script; records every call. */
function scripted(
  provider: string,
  model: string,
  answers: Array<{ choice?: Triage; confidence?: number; error?: { kind: string; [k: string]: unknown }; costUsd?: number; latencyMs?: number; throws?: boolean }>,
): DecisionRoute & { calls: { timeoutMs: number; decisionId: string }[] } {
  const calls: { timeoutMs: number; decisionId: string }[] = [];
  let i = 0;
  const invoke: DecisionInvoker = async req => {
    calls.push({ timeoutMs: req.timeoutMs, decisionId: req.decisionId });
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a.throws) throw new Error('boom');
    const latencyMs = a.latencyMs ?? 10;
    if (a.error) return { ok: false, error: a.error as never, latencyMs, attempts: 1 };
    const c = a.confidence ?? 0.9;
    const ch = a.choice ?? 'analyse';
    return {
      ok: true,
      answers: { verdict: { type: 'choice', choice: ch, confidence: c, probabilities: { [ch]: c } } } as never,
      model: `${model}-20260917`,
      usage: { inputTokens: 100, outputTokens: 1, costUsd: a.costUsd ?? 0.0001 },
      latencyMs,
      attempts: 1,
    };
  };
  return { provider, model, invoke, calls };
}

const live = (cheap: DecisionRoute | null, escalation?: DecisionRoute | null): DecisionRuntime => ({ mode: 'live', cheap, escalation });
const feats = (failedTests = 3, hardTrigger = false): TriageFeatures => ({ failedTests, hardTrigger });

describe('defineDecisionKind', () => {
  it('refuses a malformed kind at definition time', () => {
    expect(() => triageKind({ kind: 'Bad Kind' as never })).toThrow(/kind/);
    expect(() => triageKind({ policyVersion: 'a|b' })).toThrow(/policyVersion/);
    expect(() => triageKind({ featureSchemaVersion: '' })).toThrow(/featureSchemaVersion/);
    expect(() => triageKind({ decisions: [] as never })).toThrow(/decisions/);
    expect(() => triageKind({ decisions: ['skip', 'skip'] as never })).toThrow(/decisions/);
    expect(() => triageKind({ minConfidence: 1.5 })).toThrow(/minConfidence/);
    expect(() => triageKind({ escalation: { minConfidence: -1 } })).toThrow(/escalation/);
  });

  it('versions independently: policy, feature schema, prompt and threshold config', () => {
    const base = triageKind();
    expect(base.policyVersion).toBe('2026-10-03.a');
    expect(base.featureSchemaVersion).toBe('v1');
    expect(base.promptFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(base.configFingerprint).toMatch(/^[0-9a-f]{12}$/);

    const threshold = triageKind({ minConfidence: 0.9 });
    expect(threshold.promptFingerprint).toBe(base.promptFingerprint);
    expect(threshold.configFingerprint).not.toBe(base.configFingerprint);

    const prompt = triageKind({ questions: { verdict: choice('Reworded?', { analyse: 'Likely defect', skip: 'Routine' }) } as never });
    expect(prompt.promptFingerprint).not.toBe(base.promptFingerprint);
    expect(prompt.configFingerprint).toBe(base.configFingerprint);
  });
});

describe('runDecisionKind: the plan', () => {
  it('a deterministic override wins without calling any model, even when the kind is disabled', async () => {
    const cheap = scripted('openrouter', 'cheap', [{}]);
    for (const mode of ['live', 'shadow', 'disabled'] as const) {
      const r = await runDecisionKind(triageKind(), { features: feats(0, true) }, { mode, cheap });
      expect(r).toMatchObject({ decision: 'analyse', source: 'rule', reasonCode: 'hard_trigger', deterministicOverride: true, confidence: null, fallbackCause: null });
      expect(r.attempts).toEqual([]);
    }
    expect(cheap.calls).toHaveLength(0);
  });

  it('applies the cheap model at or above the kind threshold, and records the attempt', async () => {
    const cheap = scripted('openrouter', 'cheap', [{ choice: 'analyse', confidence: 0.85, costUsd: 0.0002 }]);
    const r = await runDecisionKind(triageKind(), { features: feats(), subjectRef: { type: 'worker', id: 'w1' } }, live(cheap));
    expect(r).toMatchObject({
      kind: 'test.post_session_triage', decision: 'analyse', confidence: 0.85, source: 'model', reasonCode: 'model_analyse',
      provider: 'openrouter', model: 'cheap', modelVersion: 'cheap-20260917', policyVersion: '2026-10-03.a', featureSchemaVersion: 'v1',
      fallbackCause: null, deterministicOverride: false, escalationChain: ['cheap'], escalatedFrom: null, costUsd: 0.0002,
      subjectRef: { type: 'worker', id: 'w1' }, mode: 'live',
    });
    expect(r.featureDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ index: 0, role: 'cheap', outcome: 'decided', applied: true, decision: 'analyse', confidence: 0.85, escalatedFrom: null });
    expect(cheap.calls[0].decisionId).toBe('test.post_session_triage');
  });

  it('escalates a low-confidence cheap answer to the richer slot, and applies it at the escalation threshold', async () => {
    const cheap = scripted('openrouter', 'cheap', [{ choice: 'skip', confidence: 0.6, costUsd: 0.0001 }]);
    const rich = scripted('litellm', 'rich', [{ choice: 'analyse', confidence: 0.75, costUsd: 0.002 }]);
    const r = await runDecisionKind(triageKind(), { features: feats() }, live(cheap, rich));
    expect(r).toMatchObject({ decision: 'analyse', source: 'model', provider: 'litellm', model: 'rich', escalationChain: ['cheap', 'escalation'], escalatedFrom: 0 });
    expect(r.costUsd).toBeCloseTo(0.0021, 9);
    expect(r.attempts.map(a => [a.role, a.outcome, a.applied, a.escalatedFrom])).toEqual([
      ['cheap', 'below_threshold', false, null],
      ['escalation', 'decided', true, 0],
    ]);
  });

  it('falls back with the kind\'s own fallback when both are below threshold', async () => {
    const r = await runDecisionKind(triageKind(), { features: feats() },
      live(scripted('a', 'cheap', [{ confidence: 0.5 }]), scripted('b', 'rich', [{ confidence: 0.6 }])));
    expect(r).toMatchObject({ decision: 'skip', source: 'fallback', fallbackCause: 'low_confidence', reasonCode: 'fallback_low_confidence', confidence: null, provider: null });
    expect(r.attempts.every(a => !a.applied)).toBe(true);
  });

  it('does not escalate when the caller forbids it, the kind declares no escalation, or no route is configured', async () => {
    const forbidden = await runDecisionKind(triageKind(), { features: feats(), constraints: { allowEscalation: false } },
      live(scripted('a', 'cheap', [{ confidence: 0.5 }]), scripted('b', 'rich', [{ confidence: 0.99 }])));
    expect(forbidden).toMatchObject({ source: 'fallback', escalationSkipped: 'not_allowed', escalationChain: ['cheap'] });

    const noEscalation = await runDecisionKind(triageKind({ escalation: undefined }), { features: feats() },
      live(scripted('a', 'cheap', [{ confidence: 0.5 }]), scripted('b', 'rich', [{ confidence: 0.99 }])));
    expect(noEscalation).toMatchObject({ source: 'fallback', escalationSkipped: 'not_configured' });

    const noRoute = await runDecisionKind(triageKind(), { features: feats() }, live(scripted('a', 'cheap', [{ confidence: 0.5 }]), null));
    expect(noRoute).toMatchObject({ source: 'fallback', escalationSkipped: 'no_route' });
  });

  it('skips escalation when the cost budget is already spent', async () => {
    const r = await runDecisionKind(triageKind(), { features: feats(), constraints: { maxCostUsd: 0.0001 } },
      live(scripted('a', 'cheap', [{ confidence: 0.5, costUsd: 0.0001 }]), scripted('b', 'rich', [{ confidence: 0.99 }])));
    expect(r).toMatchObject({ source: 'fallback', escalationSkipped: 'cost_budget' });
  });

  it('bounds each attempt by the latency budget and skips escalation when too little is left', async () => {
    let t = 0;
    const now = () => t;
    const cheap: DecisionRoute & { seen?: number } = {
      provider: 'a', model: 'cheap',
      invoke: async req => { cheap.seen = req.timeoutMs; t += 900; return { ok: true, answers: { verdict: { type: 'choice', choice: 'skip', confidence: 0.5, probabilities: {} } } as never, model: 'cheap', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, latencyMs: 900, attempts: 1 }; },
    };
    const rich = scripted('b', 'rich', [{ confidence: 0.99 }]);
    const r = await runDecisionKind(triageKind(), { features: feats(), constraints: { maxLatencyMs: 1_000 } }, live(cheap, rich), { now });
    expect(cheap.seen).toBe(1_000);
    expect(rich.calls).toHaveLength(0);
    expect(r).toMatchObject({ source: 'fallback', escalationSkipped: 'latency_budget', costUsd: null });
  });

  it('normalizes provider failures and leaves the fallback to the kind', async () => {
    const r = await runDecisionKind(triageKind(), { features: feats() }, live(scripted('a', 'cheap', [{ error: { kind: 'provider_error', status: 503, body: 'x' } }])));
    expect(r).toMatchObject({ decision: 'skip', source: 'fallback', fallbackCause: 'provider_failure', reasonCode: 'fallback_provider_failure' });
    expect(r.attempts[0]).toMatchObject({ outcome: 'failed', applied: false, failure: { kind: 'provider_error', status: 503, retryable: true } });
  });

  it('escalates on provider failure only when the kind opts in', async () => {
    const kind = triageKind({ escalation: { on: ['provider_failure'] } });
    const r = await runDecisionKind(kind, { features: feats() },
      live(scripted('a', 'cheap', [{ error: { kind: 'timeout', timeoutMs: 5 } }]), scripted('b', 'rich', [{ choice: 'analyse', confidence: 0.81 }])));
    expect(r).toMatchObject({ source: 'model', decision: 'analyse', escalationChain: ['cheap', 'escalation'] });
    // Not on low confidence, which this kind did not list.
    const low = await runDecisionKind(kind, { features: feats() },
      live(scripted('a', 'cheap', [{ confidence: 0.1 }]), scripted('b', 'rich', [{ confidence: 0.99 }])));
    expect(low).toMatchObject({ source: 'fallback', escalationChain: ['cheap'], escalationSkipped: null });
  });

  it('treats an invoker that throws as a transport failure, never as a throw', async () => {
    const r = await runDecisionKind(triageKind(), { features: feats() }, live(scripted('a', 'cheap', [{ throws: true }])));
    expect(r).toMatchObject({ source: 'fallback', fallbackCause: 'provider_failure' });
    expect(r.attempts[0].failure).toMatchObject({ kind: 'transport', detail: 'boom' });
  });

  it('rejects an answer outside the kind\'s decision set as an invalid response', async () => {
    const kind = triageKind({ interpret: () => ({ decision: 'escalate' as never, confidence: 0.99, reasonCode: 'x' }) });
    const r = await runDecisionKind(kind, { features: feats() }, live(scripted('a', 'cheap', [{}])));
    expect(r).toMatchObject({ source: 'fallback', fallbackCause: 'provider_failure' });
    expect(r.attempts[0].failure?.kind).toBe('invalid_response');
  });

  it('refuses unbounded or mismatched features before any spend', async () => {
    const cheap = scripted('a', 'cheap', [{}]);
    const bad = await runDecisionKind(triageKind(), { features: { failedTests: -1, hardTrigger: false } }, live(cheap));
    expect(bad).toMatchObject({ source: 'fallback', fallbackCause: 'invalid_features', featureDigest: null });
    const stale = await runDecisionKind(triageKind(), { features: feats(), featureSchemaVersion: 'v0' }, live(cheap));
    expect(stale).toMatchObject({ source: 'fallback', fallbackCause: 'invalid_features' });
    expect(cheap.calls).toHaveLength(0);
  });

  it('a disabled kind and a missing route fall back with distinct causes', async () => {
    const disabled = await runDecisionKind(triageKind(), { features: feats() }, { mode: 'disabled', cheap: scripted('a', 'cheap', [{}]) });
    expect(disabled).toMatchObject({ source: 'fallback', fallbackCause: 'disabled', mode: 'disabled' });
    const missing = await runDecisionKind(triageKind(), { features: feats() },
      { mode: 'live', cheap: null, unavailable: normalizeDecisionFailure({ kind: 'missing_key' }) });
    expect(missing).toMatchObject({ source: 'fallback', fallbackCause: 'no_provider', unavailable: { kind: 'unavailable' } });
  });

  it('shadow mode asks the model but runs the fallback, and says so', async () => {
    const r = await runDecisionKind(triageKind(), { features: feats() }, { mode: 'shadow', cheap: scripted('a', 'cheap', [{ choice: 'analyse', confidence: 0.95 }]) });
    expect(r).toMatchObject({ decision: 'skip', source: 'fallback', fallbackCause: 'shadow', mode: 'shadow' });
    expect(r.attempts[0]).toMatchObject({ outcome: 'decided', decision: 'analyse', applied: false });
  });

  it('never applies a pick from a model the kind\'s threshold was not measured on', async () => {
    const cheap = { ...scripted('a', 'other-model', [{ choice: 'analyse', confidence: 0.99 }]), isMeasured: () => false };
    const r = await runDecisionKind(triageKind(), { features: feats() }, live(cheap));
    expect(r).toMatchObject({ source: 'fallback', fallbackCause: 'unmeasured_model' });
    expect(r.attempts[0]).toMatchObject({ outcome: 'unmeasured', decision: 'analyse', applied: false });
  });

  it('hands the full response to onRecord, and a throwing sink changes nothing', async () => {
    const seen: string[] = [];
    const r = await runDecisionKind(triageKind(), { features: feats() }, live(scripted('a', 'cheap', [{}])), {
      onRecord: rec => { seen.push(rec.decision); throw new Error('ledger down'); },
    });
    expect(seen).toEqual(['analyse']);
    expect(r.decision).toBe('analyse');
  });
});

describe('runDecisionAttempt (challenger seam)', () => {
  it('runs one route as a never-applied attempt', async () => {
    const kind = triageKind();
    const a = await runDecisionAttempt(kind, scripted('b', 'challenger', [{ choice: 'analyse', confidence: 0.99 }]), feats(), { role: 'challenger', index: 3 });
    expect(a).toMatchObject({ index: 3, role: 'challenger', outcome: 'decided', applied: false, decision: 'analyse', provider: 'b', model: 'challenger' });
  });
});

describe('normalizeDecisionFailure', () => {
  it('collapses every provider error kind to a small, stable set', () => {
    expect(normalizeDecisionFailure({ kind: 'missing_key' })).toMatchObject({ kind: 'unavailable', retryable: false });
    expect(normalizeDecisionFailure({ kind: 'capability_disabled', capability: 'x' })).toMatchObject({ kind: 'unavailable' });
    expect(normalizeDecisionFailure({ kind: 'sdk_missing', message: 'm' })).toMatchObject({ kind: 'unavailable' });
    expect(normalizeDecisionFailure({ kind: 'timeout', timeoutMs: 5 })).toMatchObject({ kind: 'timeout', retryable: true });
    expect(normalizeDecisionFailure({ kind: 'rate_limited' })).toMatchObject({ kind: 'rate_limited', retryable: true });
    expect(normalizeDecisionFailure({ kind: 'provider_error', status: 400, body: '' })).toMatchObject({ kind: 'provider_error', status: 400, retryable: false });
    expect(normalizeDecisionFailure({ kind: 'parse', message: 'm' })).toMatchObject({ kind: 'invalid_response' });
    expect(normalizeDecisionFailure({ kind: 'uncalibrated', message: 'm' })).toMatchObject({ kind: 'invalid_response' });
    expect(normalizeDecisionFailure({ kind: 'invalid_request', message: 'm' })).toMatchObject({ kind: 'invalid_request' });
    expect(normalizeDecisionFailure({ kind: 'transport', message: 'm' })).toMatchObject({ kind: 'transport', retryable: true });
    expect(normalizeDecisionFailure({ kind: 'something_new' })).toMatchObject({ kind: 'transport', detail: 'something_new' });
  });
});

describe('decideRoute', () => {
  it('wraps the kit transport: no key is a normalized unavailable failure, not a throw', async () => {
    const route = decideRoute({ apiKey: null, model: 'typesafe/jev-1.13' });
    expect(route).toMatchObject({ provider: 'openrouter', model: 'typesafe/jev-1.13' });
    const r = await runDecisionKind(triageKind(), { features: feats() }, live(route));
    expect(r).toMatchObject({ source: 'fallback', fallbackCause: 'provider_failure' });
    expect(r.attempts[0].failure).toMatchObject({ kind: 'unavailable' });
  });
});
