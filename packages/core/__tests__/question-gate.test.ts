import { describe, expect, it, mock } from 'bun:test';
import { expectDecisionPinned } from '@builddai/ai-kit/decide';
import {
  DEFAULT_QUESTION_GATE_MAX_PUSHBACKS,
  DEFAULT_QUESTION_GATE_MIN_CONFIDENCE,
  QUESTION_GATE_DECISION,
  QUESTION_GATE_QUESTIONS,
  buildQuestionGateState,
  decideQuestionGateArm,
  defaultQuestionGateConfig,
  gateQuestion,
  parseQuestionGateConfig,
  parseQuestionGateRequest,
} from '../question-gate';

describe('definition', () => {
  it('is pinned: change a definition, the gate or the model, and bump the prompt version', () => {
    expectDecisionPinned(QUESTION_GATE_DECISION, { fingerprint: 'ed7f3938d8e3', version: 'qg1|typesafe/jev-1.13|engine-1' });
  });

  it('two contrastive labels', () => {
    expect(Object.keys(QUESTION_GATE_QUESTIONS.verdict.criteria).sort()).toEqual(['actionable', 'needs_context']);
    for (const def of Object.values(QUESTION_GATE_QUESTIONS.verdict.criteria)) expect(String(def)).toContain('Not for');
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

describe('arm', () => {
  const row = { id: 'exp-1', kind: 'question_gate', status: 'running', treatmentFraction: 0.5, policyVersion: 1, config: { minConfidence: 0.8 } };

  it('is deterministic per task and only treatment applies', () => {
    const a = decideQuestionGateArm(row, 'task-a');
    expect(decideQuestionGateArm(row, 'task-a')).toEqual(a);
    expect(a.apply).toBe(a.arm === 'treatment');
    expect(a.minConfidence).toBe(0.8);
  });

  it('splits tasks across both arms', () => {
    const arms = new Set(Array.from({ length: 40 }, (_, i) => decideQuestionGateArm(row, `task-${i}`).arm));
    expect(arms).toEqual(new Set(['control', 'treatment']));
  });
});

describe('gateQuestion', () => {
  const treatment = { apply: true, minConfidence: 0.7 };
  const control = { apply: false, minConfidence: 0.7 };

  it('pushes back a confident needs_context in treatment', () => {
    expect(gateQuestion({ label: 'needs_context', confidence: 0.9 }, treatment)).toEqual({ verdict: 'pushback', outcome: 'pushback' });
  });

  it('threshold is inclusive; below it the question is sent', () => {
    expect(gateQuestion({ label: 'needs_context', confidence: 0.7 }, treatment).verdict).toBe('pushback');
    expect(gateQuestion({ label: 'needs_context', confidence: 0.69 }, treatment)).toEqual({ verdict: 'send', outcome: 'actionable' });
  });

  it('control only records what it would have done', () => {
    expect(gateQuestion({ label: 'needs_context', confidence: 0.99 }, control)).toEqual({ verdict: 'send', outcome: 'shadow_needs_context' });
  });

  it('actionable is sent; a failed decision fails open', () => {
    expect(gateQuestion({ label: 'actionable', confidence: 0.99 }, treatment).verdict).toBe('send');
    expect(gateQuestion(null, treatment)).toEqual({ verdict: 'send', outcome: 'error' });
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

describe('source', () => {
  it('running scope: team AND running AND this kind; upsert appends to the task row', async () => {
    const { drizzle } = await import('drizzle-orm/pg-proxy');
    const schema = await import('../db/schema');
    const offline = drizzle(async () => ({ rows: [] }), { schema });
    mock.module('../db/client', () => ({ db: offline }));
    const src = await import('../question-gate-source');
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

    const sel = offline.select({ id: schema.experiments.id }).from(schema.experiments).where(src.runningQuestionGateScope('t-1')).toSQL();
    expect(norm(sel.sql)).toContain('where ("experiments"."team_id" = $1 and "experiments"."status" = $2 and "experiments"."kind" = $3)');
    expect(sel.params).toEqual(['t-1', 'running', 'question_gate']);

    const arm = { experimentId: 'e-1', policyVersion: 2, arm: 'treatment' as const, propensity: 0.5, apply: true, minConfidence: 0.7, maxPushbacks: 2, minSamplePerArm: 20 };
    const record = {
      at: '2026-01-01T00:00:00.000Z', workerId: 'w-1', outcome: 'pushback' as const, label: 'needs_context' as const,
      confidence: 0.9, priorPushbacks: 0, brief: { context: false, consequences: false, recommended: false }, version: 'v', latencyMs: 5,
    };
    const up = src.questionGateCheckUpsert(arm, 'task-1', record).toSQL();
    const text = norm(up.sql);
    expect(text).toContain('insert into "experiment_assignments"');
    expect(text).toContain('on conflict ("experiment_id","task_id") do update');
    expect(text).toContain(`'questiongatechecks'`);
    expect(up.params).toContain('task');
    expect(up.params).toContain(JSON.stringify([record]));
  });
});
