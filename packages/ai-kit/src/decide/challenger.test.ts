import { describe, expect, it } from 'bun:test';
import {
  choice,
  defineDecisionKind,
  runChallenger,
  runDecisionKind,
  type DecisionRoute,
  type DecisionRuntime,
} from './index';

/**
 * A challenger is a second route asked about a decision that was already made.
 * It is measured against the applied answer and never replaces it: the applied
 * response is the caller's, and `runChallenger` only reads it.
 */

interface F { risk: number; mustRun: boolean }

const kind = defineDecisionKind({
  kind: 'test.challenger_probe',
  policyVersion: 'p1',
  featureSchemaVersion: 'v1',
  decisions: ['run', 'skip'] as const,
  parseFeatures: (input: unknown) => {
    const f = input as Partial<F> | null;
    if (!f || typeof f.risk !== 'number' || typeof f.mustRun !== 'boolean') return { ok: false, message: 'bad' };
    return { ok: true, features: { risk: f.risk, mustRun: f.mustRun } };
  },
  override: f => (f.mustRun ? { decision: 'run', reasonCode: 'must_run' } : null),
  questions: { probe: choice('Run this probe?', { run: 'Likely to find a defect', skip: 'Unlikely to' }) },
  state: f => ({ risk: f.risk }),
  interpret: a => ({ decision: a.probe.choice, confidence: a.probe.confidence, reasonCode: `model_${a.probe.choice}` }),
  minConfidence: 0.8,
  fallback: (_f, cause) => ({ decision: 'skip', reasonCode: `fallback_${cause}` }),
});

function route(name: string, reply: { choice: 'run' | 'skip'; confidence: number } | 'fail' | 'throw'): DecisionRoute & { calls: number } {
  const r = {
    provider: 'acme',
    model: name,
    calls: 0,
    invoke: (async () => {
      r.calls++;
      if (reply === 'throw') throw new Error('socket hang up');
      if (reply === 'fail') return { ok: false as const, error: { kind: 'timeout' as const, timeoutMs: 5 }, latencyMs: 5, attempts: 1 };
      return {
        ok: true as const,
        answers: { probe: { type: 'choice', choice: reply.choice, confidence: reply.confidence, probabilities: { [reply.choice]: reply.confidence } } },
        model: `${name}-2026`, usage: { inputTokens: 40, outputTokens: 1, costUsd: 0.0002 }, latencyMs: 7, attempts: 1,
      };
    }) as DecisionRoute['invoke'],
  };
  return r;
}

const live = (cheap: DecisionRoute): DecisionRuntime => ({ mode: 'live', cheap, escalation: null, unavailable: null });

describe('runChallenger', () => {
  it('asks the challenger route and reports agreement with the applied answer, without touching it', async () => {
    const applied = await runDecisionKind(kind, { features: { risk: 0.5, mustRun: false } }, live(route('cheap', { choice: 'run', confidence: 0.9 })));
    const snapshot = structuredClone(applied);
    const challenger = route('rich', { choice: 'skip', confidence: 0.95 });

    const run = await runChallenger(kind, { features: { risk: 0.5, mustRun: false } }, applied, challenger);

    expect(run.status).toBe('attempted');
    expect(run.skipReason).toBeNull();
    expect(run.attempt?.role).toBe('challenger');
    expect(run.attempt?.applied).toBe(false);
    expect(run.attempt?.decision).toBe('skip');
    expect(run.attempt?.modelVersion).toBe('rich-2026');
    expect(run.appliedDecision).toBe('run');
    expect(run.agrees).toBe(false);
    // The applied response is unchanged, attempts included.
    expect(applied).toEqual(snapshot);
    expect(applied.attempts).toHaveLength(1);
  });

  it('agrees=true when the challenger picks the applied answer, even below its threshold', async () => {
    const applied = await runDecisionKind(kind, { features: { risk: 0.5, mustRun: false } }, live(route('cheap', { choice: 'run', confidence: 0.9 })));
    const run = await runChallenger(kind, { features: { risk: 0.5, mustRun: false } }, applied, route('rich', { choice: 'run', confidence: 0.6 }));
    expect(run.attempt?.outcome).toBe('below_threshold');
    expect(run.agrees).toBe(true);
  });

  it('compares against a fallback answer too: the applied answer is whatever took effect', async () => {
    const applied = await runDecisionKind(kind, { features: { risk: 0.5, mustRun: false } }, live(route('cheap', 'fail')));
    expect(applied.source).toBe('fallback');
    const run = await runChallenger(kind, { features: { risk: 0.5, mustRun: false } }, applied, route('rich', { choice: 'skip', confidence: 0.9 }));
    expect(run.status).toBe('attempted');
    expect(run.appliedSource).toBe('fallback');
    expect(run.agrees).toBe(true);
  });

  it('a failed challenger is attempted with a normalized failure and unknown agreement', async () => {
    const applied = await runDecisionKind(kind, { features: { risk: 0.5, mustRun: false } }, live(route('cheap', { choice: 'run', confidence: 0.9 })));
    const timedOut = await runChallenger(kind, { features: { risk: 0.5, mustRun: false } }, applied, route('rich', 'fail'));
    expect(timedOut.status).toBe('attempted');
    expect(timedOut.attempt?.failure?.kind).toBe('timeout');
    expect(timedOut.agrees).toBeNull();

    const threw = await runChallenger(kind, { features: { risk: 0.5, mustRun: false } }, applied, route('rich', 'throw'));
    expect(threw.attempt?.failure?.kind).toBe('transport');
  });

  describe('skips, each with its reason, and never asks the route', () => {
    it('no_route', async () => {
      const applied = await runDecisionKind(kind, { features: { risk: 0.5, mustRun: false } }, live(route('cheap', { choice: 'run', confidence: 0.9 })));
      const run = await runChallenger(kind, { features: { risk: 0.5, mustRun: false } }, applied, null);
      expect(run).toMatchObject({ status: 'skipped', skipReason: 'no_route', attempt: null, agrees: null });
    });

    it('deterministic_override: a rule decided, there is nothing to challenge', async () => {
      const applied = await runDecisionKind(kind, { features: { risk: 0.5, mustRun: true } }, live(route('cheap', { choice: 'run', confidence: 0.9 })));
      const r = route('rich', { choice: 'skip', confidence: 0.9 });
      const run = await runChallenger(kind, { features: { risk: 0.5, mustRun: true } }, applied, r);
      expect(run.skipReason).toBe('deterministic_override');
      expect(r.calls).toBe(0);
    });

    it('disabled: the kind was off for this caller', async () => {
      const applied = await runDecisionKind(kind, { features: { risk: 0.5, mustRun: false } }, { mode: 'disabled' });
      const r = route('rich', { choice: 'skip', confidence: 0.9 });
      expect((await runChallenger(kind, { features: { risk: 0.5, mustRun: false } }, applied, r)).skipReason).toBe('disabled');
      expect(r.calls).toBe(0);
    });

    it('invalid_features: the applied call refused its features', async () => {
      const applied = await runDecisionKind(kind, { features: { risk: 'x' } as never }, live(route('cheap', { choice: 'run', confidence: 0.9 })));
      const run = await runChallenger(kind, { features: { risk: 'x' } as never }, applied, route('rich', { choice: 'skip', confidence: 0.9 }));
      expect(run.skipReason).toBe('invalid_features');
    });

    it('feature_mismatch: the features handed in are not the ones the applied answer saw', async () => {
      const applied = await runDecisionKind(kind, { features: { risk: 0.5, mustRun: false } }, live(route('cheap', { choice: 'run', confidence: 0.9 })));
      const r = route('rich', { choice: 'skip', confidence: 0.9 });
      const run = await runChallenger(kind, { features: { risk: 0.9, mustRun: false } }, applied, r);
      expect(run.skipReason).toBe('feature_mismatch');
      expect(r.calls).toBe(0);
    });

    it('not_sampled: the caller drew this subject out of the challenger sample', async () => {
      const applied = await runDecisionKind(kind, { features: { risk: 0.5, mustRun: false } }, live(route('cheap', { choice: 'run', confidence: 0.9 })));
      const r = route('rich', { choice: 'skip', confidence: 0.9 });
      const run = await runChallenger(kind, { features: { risk: 0.5, mustRun: false } }, applied, r, { sampled: false });
      expect(run.skipReason).toBe('not_sampled');
      expect(r.calls).toBe(0);
    });

    it('wrong_kind: a response from another kind is refused', async () => {
      const applied = await runDecisionKind(kind, { features: { risk: 0.5, mustRun: false } }, live(route('cheap', { choice: 'run', confidence: 0.9 })));
      const run = await runChallenger(kind, { features: { risk: 0.5, mustRun: false } }, { ...applied, kind: 'test.other' as never }, route('rich', { choice: 'skip', confidence: 0.9 }));
      expect(run.skipReason).toBe('wrong_kind');
    });
  });
});
