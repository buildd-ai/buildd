/**
 * checkQuestion: the question gate's server half. On/off by experiment, the
 * threshold, max pushbacks then pass-through, fail-open paths, and that every
 * check that ran is recorded (check record + ai_usage receipt).
 */
import { describe, expect, it } from 'bun:test';
import { checkQuestion, type QuestionCheckDeps } from './question-gate-check';
import type { QuestionGateArmDecision, QuestionGateRequest } from '@buildd/core/question-gate';

const SCOPE = { teamId: 't', workspaceId: 'w', accountId: 'a', taskId: 'task-1', workerId: 'worker-1', taskTitle: 'Weekend surcharge', sensitive: false };
const BARE: QuestionGateRequest = { priorPushbacks: 0, question: { prompt: 'Should isWeekend use local time or UTC?', options: ['local time', 'UTC'] } };

const arm = (over: Partial<QuestionGateArmDecision> = {}): QuestionGateArmDecision => ({
  experimentId: 'e', policyVersion: 1, arm: 'treatment', propensity: 0.5, apply: true,
  minConfidence: 0.7, maxPushbacks: 2, minSamplePerArm: 20, ...over,
});

const run = (value: string, confidence: number) => async (opts: any) => {
  opts.onUsage?.({ kind: 'decision', decisionId: 'buildd.question_gate', provider: 'openrouter', model: 'jev', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 4, outcome: 'ok', attempts: 1 });
  return {
    ok: true, decisionId: 'buildd.question_gate', version: 'qg1|jev|engine-1',
    outcomes: { verdict: { status: confidence >= 0.7 ? 'applied' : 'suggested', reason: 'below_threshold', value, confidence, answer: {} } },
    result: { ok: true, answers: {}, model: 'jev', usage: {}, latencyMs: 4, attempts: 1 }, receipt: null,
    _state: opts.state,
  } as any;
};

function deps(over: Partial<QuestionCheckDeps> = {}) {
  const records: any[] = [];
  const receipts: any[] = [];
  const d: QuestionCheckDeps = {
    resolveArm: async () => arm(),
    resolveAccess: async () => ({ ok: true, apiKey: 'sk-team', model: 'jev' }),
    run: run('needs_context', 0.9) as any,
    record: async (_a, _t, r) => { records.push(r); },
    recordReceipts: async (r) => { receipts.push(...r); },
    ...over,
  };
  return { d, records, receipts };
}

describe('checkQuestion', () => {
  it('off: no running experiment sends the question and records nothing', async () => {
    const { d, records } = deps({ resolveArm: async () => null, run: (() => { throw new Error('must not run'); }) as any });
    expect(await checkQuestion(SCOPE, BARE, d)).toMatchObject({ verdict: 'send', outcome: 'off' });
    expect(records).toEqual([]);
  });

  it('treatment + confident needs_context: pushback with the reason, recorded with its receipt', async () => {
    let state: any;
    const { d, records, receipts } = deps({ run: (async (o: any) => { state = o.state; return run('needs_context', 0.9)(o); }) as any });
    const reply = await checkQuestion(SCOPE, BARE, d);
    expect(reply.verdict).toBe('pushback');
    expect(reply.outcome).toBe('pushback');
    expect(reply.reason).toStartWith('Not sent: a reader with no context could not decide');
    expect(reply.reason).toContain('Then ask again.');
    expect(state.question.task).toBe('Weekend surcharge');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ workerId: 'worker-1', outcome: 'pushback', label: 'needs_context', confidence: 0.9, priorPushbacks: 0, brief: { context: false, consequences: false, recommended: false } });
    expect(JSON.stringify(records[0])).not.toContain('isWeekend');
    expect(receipts).toHaveLength(1);
  });

  it('below the configured threshold the question is sent', async () => {
    const { d } = deps({ resolveArm: async () => arm({ minConfidence: 0.95 }) });
    expect(await checkQuestion(SCOPE, BARE, d)).toMatchObject({ verdict: 'send', outcome: 'actionable', label: 'needs_context', confidence: 0.9 });
  });

  it('control arm records the shadow verdict and sends', async () => {
    const { d, records } = deps({ resolveArm: async () => arm({ arm: 'control', apply: false }) });
    expect(await checkQuestion(SCOPE, BARE, d)).toMatchObject({ verdict: 'send', outcome: 'shadow_needs_context', arm: 'control' });
    expect(records[0].outcome).toBe('shadow_needs_context');
  });

  it('after max pushbacks the question passes through without a model call', async () => {
    const { d, records } = deps({ run: (() => { throw new Error('must not run'); }) as any });
    expect(await checkQuestion(SCOPE, { ...BARE, priorPushbacks: 2 }, d)).toMatchObject({ verdict: 'send', outcome: 'max_pushbacks' });
    expect(records[0]).toMatchObject({ outcome: 'max_pushbacks', priorPushbacks: 2 });
  });

  it('a sensitive workspace never sends text out', async () => {
    const { d, records } = deps({ run: (() => { throw new Error('must not run'); }) as any });
    expect(await checkQuestion({ ...SCOPE, sensitive: true }, BARE, d)).toMatchObject({ verdict: 'send', outcome: 'sensitive' });
    expect(records[0].outcome).toBe('sensitive');
  });

  it('fails open: no key, a gateway decision model, a failed run, a throw', async () => {
    const cases: Array<Partial<QuestionCheckDeps>> = [
      { resolveAccess: async () => ({ ok: false, error: { kind: 'missing_key' } }) },
      { resolveAccess: async () => ({ ok: true, apiKey: 'k', model: 'm', endpoint: { kind: 'chat', baseURL: 'https://gw.example', provider: 'openai' } as any }) },
      { run: (async () => ({ ok: false, decisionId: 'd', version: 'v', outcomes: { verdict: { status: 'skipped', reason: 'error', error: { kind: 'timeout' } } }, result: { ok: false, error: { kind: 'timeout' } }, receipt: null })) as any },
      { run: (async () => { throw new Error('boom'); }) as any },
      { resolveArm: async () => { throw new Error('db down'); } },
    ];
    for (const c of cases) {
      const { d } = deps(c);
      const reply = await checkQuestion(SCOPE, BARE, d);
      expect(reply.verdict).toBe('send');
      expect(['error', 'off']).toContain(reply.outcome);
    }
  });

  it('a complete brief is judged on its wording and recorded as complete', async () => {
    const { d, records } = deps({ run: run('actionable', 0.95) as any });
    const reply = await checkQuestion(SCOPE, {
      priorPushbacks: 1,
      question: {
        prompt: 'Should it use local time or UTC?',
        context: 'isWeekend() decides weekend surcharges.',
        options: [{ label: 'Local time', consequence: 'own calendar', recommended: true }, { label: 'UTC', consequence: 'UTC calendar' }],
      },
    }, d);
    expect(reply).toMatchObject({ verdict: 'send', outcome: 'actionable' });
    expect(records[0].brief).toEqual({ context: true, consequences: true, recommended: true });
  });
});
