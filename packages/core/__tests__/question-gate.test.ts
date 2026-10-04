import { describe, expect, it } from 'bun:test';
import { expectDecisionPinned } from '@builddai/ai-kit/decide';
import {
  DEFAULT_QUESTION_GATE_MAX_PUSHBACKS,
  DEFAULT_QUESTION_GATE_MIN_CONFIDENCE,
  OPTION_SLOTS,
  QUESTION_DECIDE_DECISION,
  QUESTION_DECIDE_QUESTIONS,
  QUESTION_GATE_DECISION,
  QUESTION_GATE_QUESTIONS,
  buildQuestionGateState,
  defaultQuestionGateConfig,
  detectHardRail,
  fingerprintOf,
  gateQuestion,
  parseQuestionGateConfig,
  parseQuestionGateRequest,
  readQuestionDecideRun,
  resolveDecideOutcome,
} from '../question-gate';

describe('definitions', () => {
  it('stage 1 is pinned: change a definition, the gate or the model, and bump the prompt version', () => {
    expectDecisionPinned(QUESTION_GATE_DECISION, { fingerprint: 'ed7f3938d8e3', version: 'qg1|typesafe/jev-1.13|engine-1' });
  });

  it('stage 1 has two contrastive labels', () => {
    expect(Object.keys(QUESTION_GATE_QUESTIONS.verdict.criteria).sort()).toEqual(['actionable', 'needs_context']);
    for (const def of Object.values(QUESTION_GATE_QUESTIONS.verdict.criteria)) expect(String(def)).toContain('Not for');
  });

  it('stage 2 (decide/hold/ask) is pinned', () => {
    expectDecisionPinned(QUESTION_DECIDE_DECISION, { fingerprint: '7a098d6cdad3', version: 'qd1|typesafe/jev-1.13|engine-1' });
  });

  it('stage 2 offers exactly decide/hold/ask, and OPTION_SLOTS option-index labels', () => {
    expect(Object.keys(QUESTION_DECIDE_QUESTIONS.disposition.criteria).sort()).toEqual(['ask', 'decide', 'hold']);
    expect(Object.keys(QUESTION_DECIDE_QUESTIONS.optionIndex.criteria)).toHaveLength(OPTION_SLOTS);
  });
});

describe('config', () => {
  it('defaults are conservative and written out', () => {
    expect(DEFAULT_QUESTION_GATE_MIN_CONFIDENCE).toBe(0.7);
    expect(DEFAULT_QUESTION_GATE_MAX_PUSHBACKS).toBe(2);
    expect(parseQuestionGateConfig(defaultQuestionGateConfig())).toMatchObject({ minConfidence: 0.7, maxPushbacks: 2 });
  });

  it('accepts a configured threshold and pushback cap, rejects nonsense', () => {
    expect(parseQuestionGateConfig({ minConfidence: 0.85, maxPushbacks: 1 })).toMatchObject({ minConfidence: 0.85, maxPushbacks: 1 });
    expect(parseQuestionGateConfig({ minConfidence: 0.2, maxPushbacks: 9 })).toMatchObject({ minConfidence: 0.7, maxPushbacks: 2 });
    expect(parseQuestionGateConfig('junk')).toMatchObject({ minConfidence: 0.7, maxPushbacks: 2 });
  });
});

describe('gateQuestion (stage 1)', () => {
  it('pushes back a confident needs_context', () => {
    expect(gateQuestion({ label: 'needs_context', confidence: 0.9 }, 0.7)).toEqual({ verdict: 'pushback', outcome: 'pushback' });
  });

  it('threshold is inclusive; below it the question is sent', () => {
    expect(gateQuestion({ label: 'needs_context', confidence: 0.7 }, 0.7).verdict).toBe('pushback');
    expect(gateQuestion({ label: 'needs_context', confidence: 0.69 }, 0.7)).toEqual({ verdict: 'send', outcome: 'actionable' });
  });

  it('actionable is sent; a failed decision fails open', () => {
    expect(gateQuestion({ label: 'actionable', confidence: 0.99 }, 0.7).verdict).toBe('send');
    expect(gateQuestion(null, 0.7)).toEqual({ verdict: 'send', outcome: 'error' });
  });
});

describe('request', () => {
  it('parses a brief and drops junk', () => {
    const r = parseQuestionGateRequest({
      priorPushbacks: 1,
      question: {
        prompt: ' Local or UTC? ',
        context: 'isWeekend() decides surcharges.',
        options: [{ label: 'Local', consequence: 'own calendar', recommended: true, extra: 'x' }, 'UTC', { nope: 1 }],
        recommended: { label: 'Local', reason: 'own calendar' },
        where: { taskTitle: 'Weekend surcharge', branch: 'b' },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      priorPushbacks: 1,
      question: {
        prompt: 'Local or UTC?',
        context: 'isWeekend() decides surcharges.',
        options: [{ label: 'Local', consequence: 'own calendar', recommended: true }, 'UTC'],
        recommended: { label: 'Local', reason: 'own calendar' },
        where: { taskTitle: 'Weekend surcharge' },
      },
    });
  });

  it('requires a prompt and a sane pushback count', () => {
    expect(parseQuestionGateRequest({ question: {} }).ok).toBe(false);
    expect(parseQuestionGateRequest({ question: { prompt: 'x' }, priorPushbacks: -1 }).ok).toBe(false);
    const r = parseQuestionGateRequest({ question: { prompt: 'x' } });
    expect(r.ok && r.value.priorPushbacks).toBe(0);
  });
});

describe('state', () => {
  it('is the question as a person would see it, absences explicit', () => {
    expect(buildQuestionGateState({ prompt: 'Should isWeekend use local time or UTC?', options: ['local time', 'UTC'] }, 'Weekend surcharge')).toEqual({
      question: {
        task: 'Weekend surcharge',
        context: null,
        asks: 'Should isWeekend use local time or UTC?',
        options: [{ label: 'local time', leadsTo: null }, { label: 'UTC', leadsTo: null }],
        recommended: null,
      },
    });
  });
});

describe('detectHardRail', () => {
  it('migration: the destructive-schema-change paths, default or detected', () => {
    expect(detectHardRail({ pathManifest: ['packages/core/db/schema.ts'] })).toBe('migration');
    expect(detectHardRail({ pathManifest: ['packages/core/drizzle/0001_x.sql'] })).toBe('migration');
    expect(detectHardRail({ pathManifest: ['src/schema.ts'], schemaPaths: ['src/schema.ts'] })).toBe('migration');
  });

  it('auth_secrets', () => {
    expect(detectHardRail({ pathManifest: ['apps/web/src/app/api/secrets/route.ts'] })).toBe('auth_secrets');
    expect(detectHardRail({ pathManifest: ['packages/core/secrets/crypto.ts'] })).toBe('auth_secrets');
  });

  it('ci_deploy', () => {
    expect(detectHardRail({ pathManifest: ['.github/workflows/build.yml'] })).toBe('ci_deploy');
    expect(detectHardRail({ pathManifest: ['vercel.json'] })).toBe('ci_deploy');
  });

  it('protected_path: only the workspace\'s own declared paths, never assumed', () => {
    expect(detectHardRail({ pathManifest: ['infra/terraform/main.tf'], protectedPaths: ['infra/terraform/'] })).toBe('protected_path');
    expect(detectHardRail({ pathManifest: ['infra/terraform/main.tf'] })).toBeNull();
  });

  it('spending: a heuristic over the question\'s own text, not a path lookup', () => {
    expect(detectHardRail({ questionText: 'Should we upgrade the plan to cover this?' })).toBe('spending');
    expect(detectHardRail({ questionText: 'That costs $50/mo — approve the subscription?' })).toBe('spending');
    expect(detectHardRail({ questionText: 'Local time or UTC?' })).toBeNull();
  });

  it('checks in a fixed order; the first rail hit wins', () => {
    expect(detectHardRail({ pathManifest: ['packages/core/db/schema.ts', '.github/workflows/x.yml'] })).toBe('migration');
  });

  it('no manifest and ordinary text: no rail', () => {
    expect(detectHardRail({})).toBeNull();
  });
});

describe('readQuestionDecideRun / resolveDecideOutcome (stage 2)', () => {
  const run = (overrides: Partial<{ disposition: string; dispositionConfidence: number; optionLabel: string | null; optionConfidence: number | null }> = {}) => {
    const d = { disposition: 'decide', dispositionConfidence: 0.9, optionLabel: 'opt1', optionConfidence: 0.8, ...overrides };
    return {
      ok: true, decisionId: 'buildd.question_decide', version: 'v',
      outcomes: {
        disposition: { status: 'applied', value: d.disposition, confidence: d.dispositionConfidence, answer: {} },
        optionIndex: d.optionLabel
          ? { status: 'applied', value: d.optionLabel, confidence: d.optionConfidence, answer: {} }
          : { status: 'skipped', reason: 'not_candidate' },
      },
      result: { ok: true, answers: {}, model: 'jev', usage: {}, latencyMs: 4, attempts: 1 }, receipt: null,
    } as any;
  };

  it('reads disposition and the option index', () => {
    const answer = readQuestionDecideRun(run());
    expect(answer).toEqual({ disposition: 'decide', dispositionConfidence: 0.9, optionIndex: 1, optionIndexConfidence: 0.8 });
  });

  it('a decide with a confident, valid index resolves to decide', () => {
    const resolution = resolveDecideOutcome(readQuestionDecideRun(run()) as any, 2, 0.7);
    expect(resolution).toEqual({ disposition: 'decide', confidence: 0.9, optionIndex: 1, optionConfidence: 0.8 });
  });

  it('low confidence falls back to ask, whatever the disposition', () => {
    const answer = readQuestionDecideRun(run({ dispositionConfidence: 0.5 })) as any;
    expect(resolveDecideOutcome(answer, 2, 0.7)).toMatchObject({ disposition: 'ask', fellBackReason: 'low_confidence' });
  });

  it('decide with no usable option index falls back to ask', () => {
    const noIndex = readQuestionDecideRun(run({ optionLabel: null })) as any;
    expect(resolveDecideOutcome(noIndex, 2, 0.7)).toMatchObject({ disposition: 'ask', fellBackReason: 'invalid_option' });
    const outOfRange = readQuestionDecideRun(run({ optionLabel: 'opt5' })) as any;
    expect(resolveDecideOutcome(outOfRange, 2, 0.7)).toMatchObject({ disposition: 'ask', fellBackReason: 'invalid_option' });
  });

  it('decide with no options on the question at all falls back to ask', () => {
    const answer = readQuestionDecideRun(run()) as any;
    expect(resolveDecideOutcome(answer, 0, 0.7)).toMatchObject({ disposition: 'ask', fellBackReason: 'no_options' });
  });

  it('a confident hold resolves to hold', () => {
    const answer = readQuestionDecideRun(run({ disposition: 'hold', optionLabel: null })) as any;
    expect(resolveDecideOutcome(answer, 2, 0.7)).toEqual({ disposition: 'hold', confidence: 0.9 });
  });

  it('a confident ask resolves to ask with no fallback reason', () => {
    const answer = readQuestionDecideRun(run({ disposition: 'ask', optionLabel: null })) as any;
    expect(resolveDecideOutcome(answer, 2, 0.7)).toEqual({ disposition: 'ask', confidence: 0.9 });
  });

  it('a failed run reads as an error', () => {
    const failed = { ok: false, decisionId: 'd', version: 'v', outcomes: { disposition: { status: 'skipped', reason: 'error' }, optionIndex: { status: 'skipped', reason: 'error' } }, result: { ok: false, error: { kind: 'timeout' } }, receipt: null } as any;
    expect(readQuestionDecideRun(failed)).toEqual({ error: 'timeout' });
  });
});

describe('fingerprintOf', () => {
  it('is deterministic and sensitive to its input', () => {
    expect(fingerprintOf({ a: 1 })).toBe(fingerprintOf({ a: 1 }));
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
  });
});
