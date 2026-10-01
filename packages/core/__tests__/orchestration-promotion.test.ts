import { describe, it, expect } from 'bun:test';
import { choice, defineDecision, JEV_MODEL } from '@builddai/ai-kit/decide';
import {
  ORCHESTRATION_PROMOTIONS,
  claimHoldIdentity,
  manifestPickIdentity,
  measuredIdentity,
  resolveApplyingFraction,
  type PromotionEvidence,
} from '../orchestration-promotion';
import { CLAIM_HOLD_DECISION, CLAIM_HOLD_QUESTIONS, CLAIM_HOLD_APPLYING_FRACTION } from '../orchestration-claim-decision';
import { buildPickDecision, MANIFEST_DECISION_ID, MANIFEST_CANDIDATE_POLICY_VERSION } from '../manifest-prediction';
import { runOrchestrationDecision } from '../orchestration-decision';

/**
 * The promotion guard (§6): a non-zero applying cohort exists only behind an
 * `eligible_for_gated` readout for the exact measured definition. Synthetic
 * fixtures only.
 */

const gated = (minConfidence = 0.9, promptVersion = 'ch1') => defineDecision({
  id: CLAIM_HOLD_DECISION.id,
  promptVersion,
  questions: CLAIM_HOLD_QUESTIONS,
  mode: 'gated',
  minConfidence,
});

const evidence = (over: Partial<PromotionEvidence> = {}): PromotionEvidence => ({
  decisionId: CLAIM_HOLD_DECISION.id,
  candidatePolicyVersion: 'ch1.open_pr_overlap',
  measuredFingerprint: claimHoldIdentity(CLAIM_HOLD_DECISION),
  verdict: 'eligible_for_gated',
  threshold: 0.9,
  maxApplyingFraction: 0.05,
  readoutRef: 'private-readout-fixture',
  ...over,
});

const resolve = (over: Partial<Parameters<typeof resolveApplyingFraction>[0]> = {}) => resolveApplyingFraction({
  decision: gated(),
  question: 'action',
  candidatePolicyVersion: 'ch1.open_pr_overlap',
  requestedFraction: 0.05,
  promotions: [evidence()],
  ...over,
});

describe('shipped state', () => {
  it('records no promotion: every cohort resolves to zero', () => {
    expect(ORCHESTRATION_PROMOTIONS).toEqual([]);
    expect(CLAIM_HOLD_APPLYING_FRACTION).toBe(0);
    const r = resolveApplyingFraction({ decision: gated(), question: 'action', candidatePolicyVersion: 'ch1.open_pr_overlap', requestedFraction: 0.5 });
    expect(r).toEqual({ fraction: 0, refusal: 'no_evidence' });
  });
});

describe('resolveApplyingFraction', () => {
  it('allows the requested cohort behind matching eligible evidence', () => {
    expect(resolve()).toEqual({ fraction: 0.05, refusal: null });
  });

  it('caps the cohort at the evidence maximum (a small cohort, never more)', () => {
    expect(resolve({ requestedFraction: 0.5 })).toEqual({ fraction: 0.05, refusal: 'capped' });
  });

  it('zero, negative or non-finite requests roll back to zero', () => {
    for (const f of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolve({ requestedFraction: f })).toEqual({ fraction: 0, refusal: 'zero_requested' });
    }
  });

  it('a shadow definition never applies, whatever the evidence says', () => {
    expect(resolve({ decision: CLAIM_HOLD_DECISION })).toEqual({ fraction: 0, refusal: 'shadow_mode' });
  });

  it('refuses without evidence for this decision and candidate policy', () => {
    expect(resolve({ promotions: [] }).refusal).toBe('no_evidence');
    expect(resolve({ candidatePolicyVersion: 'ch1.advisory_manifest' }).refusal).toBe('no_evidence');
    expect(resolve({ promotions: [evidence({ decisionId: 'buildd.other' })] }).refusal).toBe('no_evidence');
  });

  it('refuses insufficient or worse evidence', () => {
    expect(resolve({ promotions: [evidence({ verdict: 'insufficient_n', threshold: null })] })).toEqual({ fraction: 0, refusal: 'not_eligible' });
    expect(resolve({ promotions: [evidence({ verdict: 'worse_than_baseline', threshold: null })] })).toEqual({ fraction: 0, refusal: 'not_eligible' });
  });

  it('refuses a fingerprint mismatch: the questions or model changed since the readout', () => {
    const changed = defineDecision({
      id: CLAIM_HOLD_DECISION.id,
      promptVersion: 'ch2',
      questions: { action: choice('Different question?', { HOLD: 'h', START: 's' }) },
      mode: 'gated',
      minConfidence: 0.9,
    });
    expect(resolve({ decision: changed })).toEqual({ fraction: 0, refusal: 'fingerprint_mismatch' });
    expect(resolve({ promotions: [evidence({ measuredFingerprint: '000000000000' })] }).refusal).toBe('fingerprint_mismatch');
  });

  it('refuses a deployed threshold that is not the measured one', () => {
    expect(resolve({ decision: gated(0.8) })).toEqual({ fraction: 0, refusal: 'threshold_mismatch' });
  });

  it('refuses evidence without a cohort ceiling', () => {
    expect(resolve({ promotions: [evidence({ maxApplyingFraction: null })] }).refusal).toBe('no_cohort_ceiling');
  });
});

describe('measured identity', () => {
  it('ignores rollout policy (mode, threshold) but not questions or model', () => {
    expect(measuredIdentity(gated(0.9))).toBe(measuredIdentity(CLAIM_HOLD_DECISION));
    expect(measuredIdentity(gated(0.7))).toBe(measuredIdentity(CLAIM_HOLD_DECISION));
    const otherModel = defineDecision({ id: CLAIM_HOLD_DECISION.id, promptVersion: 'ch1', questions: CLAIM_HOLD_QUESTIONS, mode: 'shadow', model: 'typesafe/jev-0.0' });
    expect(measuredIdentity(otherModel)).not.toBe(measuredIdentity(CLAIM_HOLD_DECISION));
  });

  it('pins the dynamic manifest pick by its template, independent of the files offered', () => {
    const a = buildPickDecision(['a.ts']).decision;
    const b = buildPickDecision(['b.ts', 'c.ts']).decision;
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(manifestPickIdentity()).toBe(manifestPickIdentity());
    expect(typeof manifestPickIdentity()).toBe('string');
    const r = resolveApplyingFraction({
      decision: buildPickDecision(['x.ts'], { mode: 'gated', minConfidence: 0.9 }).decision,
      question: 'pick',
      candidatePolicyVersion: MANIFEST_CANDIDATE_POLICY_VERSION,
      requestedFraction: 0.05,
      identity: manifestPickIdentity(),
      promotions: [evidence({ decisionId: MANIFEST_DECISION_ID, candidatePolicyVersion: MANIFEST_CANDIDATE_POLICY_VERSION, measuredFingerprint: manifestPickIdentity() })],
    });
    expect(r).toEqual({ fraction: 0.05, refusal: null });
  });
});

describe('non-Jev stays record-only even behind a granted cohort', () => {
    const run = (model: string) => {
    const decision = gated();
    const { fraction } = resolve({ decision, requestedFraction: 1, promotions: [evidence({ maxApplyingFraction: 1 })] });
    expect(fraction).toBe(1);
    return runOrchestrationDecision({
      decision,
      question: 'action',
      capability: 'orchestration_claim',
      scope: { teamId: 't', workspaceId: 'w', taskId: 'task' },
      ruleVerdict: 'HOLD',
      candidatePolicy: { version: 'ch1.open_pr_overlap', digest: 'd', count: 2 },
      buildState: async () => ({ x: 1 }),
      cohort: { fraction, unitId: 'task' },
      deps: {
        resolveAccess: async () => ({ ok: true, apiKey: 'k', model }) as any,
        call: (async () => ({
          ok: true,
          model,
          answers: { action: { type: 'choice', choice: 'START', probabilities: { HOLD: 0.02, START: 0.98 }, confidence: 0.98 } },
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          latencyMs: 5,
          attempts: 1,
        })) as any,
        record: async () => {},
      },
    });
  };

  it('a non-Jev answer is suggested, never applied', async () => {
    const out = await run('acme/other-model');
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('non_jev');
    expect(out.effective).toBe('HOLD');
  });

  it('the same answer from Jev applies (the cohort is real)', async () => {
    const out = await run(JEV_MODEL);
    expect(out.applied).toBe(true);
    expect(out.effective).toBe('START');
  });
});
