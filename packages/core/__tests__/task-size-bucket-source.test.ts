import { describe, it, expect, mock } from 'bun:test';
import { JEV_MODEL } from '@builddai/ai-kit/decide';
import { estimateExpectedSize } from '../task-size-bucket-source';
import { SIZE_BUCKET_ESTIMATES } from '../task-size-bucket-decision';
import { isInferenceAllowed, OPT_IN_CAPABILITIES } from '../inference-policy';
import type { OrchestrationDecisionOutcome } from '../orchestration-decision';

/**
 * The Jev S/M/L fallback (jev-scheduling §3) for when `estimateTaskSize` has
 * fewer than k neighbours. Every dependency is injected: no DB, no network.
 */

function args(over: Partial<Parameters<typeof estimateExpectedSize>[0]> = {}) {
  return {
    workspaceId: 'ws-1',
    taskId: 'task-1',
    teamId: 'team-1',
    missionId: null,
    accountId: null,
    userId: null,
    seedText: 'fix the thing',
    cutoff: new Date('2026-09-10T00:00:00Z'),
    title: 'Fix the thing',
    description: 'a small fix',
    signal: new AbortController().signal,
    ...over,
  };
}

const outcome = (over: Partial<OrchestrationDecisionOutcome> = {}): OrchestrationDecisionOutcome => ({
  effective: 'M', applied: false, status: 'fallback', reason: 'capability_disabled', suggested: null, confidence: null, row: null, ...over,
});

describe('estimateExpectedSize', () => {
  it('uses the neighbour estimate directly when there is one, never asking Jev', async () => {
    const neighbourResult = { files: 4, minutes: 30, source: 'neighbours' as const, k: 5, n: 5 };
    const estimateSize = mock(async () => neighbourResult);
    const decide = mock(async () => outcome());
    const result = await estimateExpectedSize(args(), { estimateSize, decide });
    expect(result).toEqual(neighbourResult);
    expect(decide).not.toHaveBeenCalled();
  });

  it('a throwing neighbour estimate is treated as null, falling through to the Jev bucket', async () => {
    const estimateSize = mock(async () => { throw new Error('db down'); });
    const decide = mock(async () => outcome({ applied: true, status: 'applied', effective: 'S', confidence: 0.9, suggested: 'S' }));
    const result = await estimateExpectedSize(args(), { estimateSize, decide });
    expect(result).toEqual({ ...SIZE_BUCKET_ESTIMATES.S, source: 'jev', bucket: 'S', confidence: 0.9 });
  });

  it('fewer than k neighbours (null) ⇒ asks Jev with the right shape', async () => {
    const estimateSize = mock(async () => null);
    const decide = mock(async (p: any) => {
      expect(p.question).toBe('bucket');
      expect(p.capability).toBe('orchestration_ordering');
      expect(p.ruleVerdict).toBe('M');
      expect(p.isValidAnswer('L')).toBe(true);
      expect(p.isValidAnswer('XL')).toBe(false);
      const state = await p.buildState();
      expect(state).toEqual({ title: 'Fix the thing', description: 'a small fix' });
      return outcome({ applied: true, status: 'applied', effective: 'L', confidence: 0.85, suggested: 'L' });
    });
    const result = await estimateExpectedSize(args(), { estimateSize, decide });
    expect(result).toEqual({ ...SIZE_BUCKET_ESTIMATES.L, source: 'jev', bucket: 'L', confidence: 0.85 });
  });

  it('below-threshold (suggested) falls back to null — today\'s "fewer than k ⇒ null" behaviour', async () => {
    const estimateSize = mock(async () => null);
    const decide = mock(async () => outcome({ applied: false, status: 'suggested', reason: 'below_threshold', effective: 'M', suggested: 'M', confidence: 0.4 }));
    expect(await estimateExpectedSize(args(), { estimateSize, decide })).toBeNull();
  });

  it('a timeout/error falls back to null', async () => {
    const estimateSize = mock(async () => null);
    const decide = mock(async () => outcome({ applied: false, status: 'fallback', reason: 'deadline', effective: 'M' }));
    expect(await estimateExpectedSize(args(), { estimateSize, decide })).toBeNull();
  });

  it('capability off falls back to null, no call attempted beyond the access check', async () => {
    const estimateSize = mock(async () => null);
    const decide = mock(async () => outcome({ applied: false, status: 'fallback', reason: 'capability_disabled', effective: 'M' }));
    expect(await estimateExpectedSize(args(), { estimateSize, decide })).toBeNull();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('a thrown decide never propagates: the result is null, matching every other orchestration decision\'s fail-open contract', async () => {
    const estimateSize = mock(async () => null);
    const decide = mock(async () => { throw new Error('boom'); });
    expect(await estimateExpectedSize(args(), { estimateSize, decide })).toBeNull();
  });
});

describe('end-to-end through the real runOrchestrationDecision (rails)', () => {
  const harnessDeps = (over: Record<string, unknown> = {}) => ({
    resolveAccess: async () => ({ ok: true, apiKey: 'k', model: JEV_MODEL }),
    call: async () => ({
      ok: true as const,
      answers: { bucket: { choice: 'S', confidence: 0.3, distribution: { S: 0.3 } } },
      model: JEV_MODEL,
      usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.00001 },
      latencyMs: 5,
      attempts: 1,
    }),
    record: async () => {},
    ...over,
  });

  it('below the gated minConfidence, the rule stands: expectedSize stays null', async () => {
    const estimateSize = mock(async () => null);
    const result = await estimateExpectedSize(args(), { estimateSize, decisionDeps: harnessDeps() as any, applyingFraction: 1 });
    expect(result).toBeNull();
  });

  it('a decision-call timeout falls back: expectedSize stays null', async () => {
    const estimateSize = mock(async () => null);
    const slowCall = () => new Promise(() => {}); // never resolves
    const result = await estimateExpectedSize(args(), {
      estimateSize,
      decisionDeps: harnessDeps({ call: slowCall }) as any,
      applyingFraction: 1,
      deadlineMs: 20,
    });
    expect(result).toBeNull();
  });

  it('a confident, in-cohort Jev answer applies', async () => {
    const estimateSize = mock(async () => null);
    const call = async () => ({
      ok: true as const,
      answers: { bucket: { choice: 'M', confidence: 0.95, distribution: { M: 0.95 } } },
      model: JEV_MODEL,
      usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.00001 },
      latencyMs: 5,
      attempts: 1,
    });
    const result = await estimateExpectedSize(args(), {
      estimateSize,
      decisionDeps: harnessDeps({ call }) as any,
      applyingFraction: 1,
    });
    expect(result).toEqual({ ...SIZE_BUCKET_ESTIMATES.M, source: 'jev', bucket: 'M', confidence: 0.95 });
  });

  it('a non-Jev model answer is never applied, even confidently', async () => {
    const estimateSize = mock(async () => null);
    const call = async () => ({
      ok: true as const,
      answers: { bucket: { choice: 'L', confidence: 0.99, distribution: { L: 0.99 } } },
      model: 'some-other-model',
      usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.00001 },
      latencyMs: 5,
      attempts: 1,
    });
    const result = await estimateExpectedSize(args(), {
      estimateSize,
      decisionDeps: harnessDeps({ call, resolveAccess: async () => ({ ok: true, apiKey: 'k', model: 'some-other-model' }) }) as any,
      applyingFraction: 1,
    });
    expect(result).toBeNull();
  });

  it('the capability is opt-in and off by default for a team that has not listed it', () => {
    expect(OPT_IN_CAPABILITIES).toContain('orchestration_ordering');
    expect(isInferenceAllowed('orchestration_ordering', { enabledDecisionShadows: null })).toBe(false);
    expect(isInferenceAllowed('orchestration_ordering', { enabledDecisionShadows: ['orchestration_ordering'] })).toBe(true);
  });
});
