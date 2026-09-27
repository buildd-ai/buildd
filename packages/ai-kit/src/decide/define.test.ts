import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageReceipt } from '../models/index';
import {
  choice,
  defineDecision,
  expectDecisionPinned,
  JEV_MODEL,
  KIT_VERSION,
  noul,
  score,
  type DecisionReceipt,
  type DecisionRun,
  toModelsUsage,
} from './index';

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

const config = () => ({
  id: 'test.email',
  promptVersion: '2026-09-27.a',
  questions: {
    kind: choice('Which bucket?', { actionable: 'Needs doing', informative: 'FYI', noise: 'Bulk' }),
    concerning: noul('Money problem?', { true: 'Yes', false: 'No' }),
  },
  mode: 'shadow' as const,
  modes: { concerning: 'live' as const },
  minConfidence: { concerning: 0.6 },
});

describe('defineDecision versioning', () => {
  it('names prompt version, model and kit release', () => {
    const d = defineDecision(config());
    expect(d.version).toBe(`2026-09-27.a|${JEV_MODEL}|kit-${KIT_VERSION}`);
    expect(d.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('KIT_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8'));
    expect(KIT_VERSION).toBe(pkg.version);
  });

  it('fingerprint ignores key order but not content, modes, thresholds or model', () => {
    const base = defineDecision(config()).fingerprint;
    const c = config();
    const reordered = { ...c, questions: { concerning: c.questions.concerning, kind: choice('Which bucket?', { noise: 'Bulk', informative: 'FYI', actionable: 'Needs doing' }) } };
    expect(defineDecision(reordered).fingerprint).toBe(base);
    // promptVersion and timeoutMs are not definitions
    expect(defineDecision({ ...c, promptVersion: '2026-09-28.b', timeoutMs: 1 }).fingerprint).toBe(base);

    const variants = [
      { ...c, questions: { ...c.questions, kind: choice('Which bucket?', { actionable: 'Needs doing!', informative: 'FYI', noise: 'Bulk' }) } },
      { ...c, questions: { ...c.questions, concerning: noul('Money problem?') } },
      { ...c, minConfidence: { concerning: 0.7 } },
      { ...c, modes: {} },
      { ...c, model: 'typesafe/jev-1.14' },
    ];
    for (const v of variants) expect(defineDecision(v as never).fingerprint).not.toBe(base);
  });

  it('score level order is part of the fingerprint', () => {
    const a = defineDecision({ id: 'test.s', promptVersion: 'v1', questions: { s: score('Level', ['low', 'high']) }, mode: 'shadow' });
    const b = defineDecision({ id: 'test.s', promptVersion: 'v1', questions: { s: score('Level', ['high', 'low']) }, mode: 'shadow' });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('expectDecisionPinned (the fingerprint test)', () => {
  const d = defineDecision(config());

  it('passes when the definition is unchanged', () => {
    expect(() => expectDecisionPinned(d, { fingerprint: d.fingerprint, version: d.version })).not.toThrow();
  });

  it('fails when a definition changes without re-pinning, naming the new fingerprint', () => {
    const c = config();
    const edited = defineDecision({ ...c, questions: { ...c.questions, concerning: noul('Any money problem?') } });
    expect(() => expectDecisionPinned(edited, { fingerprint: d.fingerprint })).toThrow(
      new RegExp(`bump promptVersion, then pin fingerprint '${edited.fingerprint}'`),
    );
  });

  it('fails when the model or kit release changed under a pinned version', () => {
    const other = defineDecision({ ...config(), model: 'typesafe/jev-1.14' });
    expect(() => expectDecisionPinned(other, { fingerprint: other.fingerprint, version: d.version })).toThrow(/re-run the eval/);
  });
});

describe('defineDecision validation', () => {
  it('rejects a gated question without a threshold', () => {
    expect(() => defineDecision({ ...config(), mode: 'gated', minConfidence: undefined, modes: undefined })).toThrow(/needs a minConfidence/);
  });
  it('rejects bad ids, versions, thresholds and unknown question names', () => {
    expect(() => defineDecision({ ...config(), id: 'noapp' })).toThrow(/namespaced/);
    expect(() => defineDecision({ ...config(), promptVersion: 'a|b' })).toThrow(/promptVersion/);
    expect(() => defineDecision({ ...config(), minConfidence: 1.5 })).toThrow(/\[0, 1\]/);
    expect(() => defineDecision({ ...config(), modes: { nope: 'live' } } as never)).toThrow(/unknown question 'nope'/);
    expect(() => defineDecision({ ...config(), questions: { q: choice('i', { only: null }) } } as never)).toThrow(/at least 2/);
  });
});

const ANSWERS = (p: number, conf = 0.95) => ({
  kind: { type: 'choice', choice: 'noise', probabilities: { actionable: 0, informative: 0.05, noise: 0.95 }, confidence: conf },
  concerning: { type: 'noul', noul: p },
});

describe('decision.run', () => {
  it('applies per-question modes: shadow choice suggested, live noul applied', async () => {
    const d = defineDecision(config());
    const persisted: DecisionRun<typeof d.questions>[] = [];
    const run = await d.run({
      apiKey: 'k', state: { subject: 'Payment failed' }, sleep: noSleep,
      fetch: async () => jsonResponse(okBody(ANSWERS(0.8))),
      onDecision: r => { persisted.push(r); },
    });
    expect(run.ok).toBe(true);
    expect(run.outcomes.kind).toMatchObject({ status: 'suggested', reason: 'shadow', value: 'noise' });
    expect(run.outcomes.concerning).toMatchObject({ status: 'applied', value: true });
    expect(run.version).toBe(d.version);
    expect(run.receipt).toMatchObject({ decisionId: 'test.email', outcome: 'ok' });
    expect(persisted).toHaveLength(1);
  });

  it('skips every question on a failed call and survives a throwing onDecision', async () => {
    const d = defineDecision(config());
    const run = await d.run({
      apiKey: 'k', state: 'x', sleep: noSleep,
      fetch: async () => jsonResponse({}, 401),
      onDecision: () => { throw new Error('db down'); },
    });
    expect(run.ok).toBe(false);
    expect(run.outcomes.kind).toMatchObject({ status: 'skipped', reason: 'error', error: { kind: 'provider_error' } });
    expect(run.outcomes.concerning.status).toBe('skipped');
  });

  it('no receipt when nothing was sent', async () => {
    const run = await defineDecision(config()).run({ apiKey: '', state: 'x' });
    expect(run.receipt).toBeNull();
  });
});

describe('decision.runEach', () => {
  it('fans out one state per request and totals cost', async () => {
    const d = defineDecision(config());
    const states: unknown[] = [];
    const res = await d.runEach([1, 2, 3], {
      apiKey: 'k', sleep: noSleep, stateOf: n => ({ n }), concurrency: 2,
      fetch: async (_u: string, init: RequestInit = {}) => {
        states.push(JSON.parse(init.body as string).state);
        return jsonResponse(okBody(ANSWERS(0.1), 0.001));
      },
    });
    expect(states).toHaveLength(3);
    expect(states).toContainEqual({ n: 2 });
    expect(res.stats).toEqual({ attempted: 3, answered: 3, failed: 0, unfinished: 0, costUsd: 0.003 });
    expect(res.items.map(i => i.item)).toEqual([1, 2, 3]);
  });

  it('stops at the run budget', async () => {
    const d = defineDecision(config());
    const res = await d.runEach(Array.from({ length: 20 }, (_, i) => i), {
      apiKey: 'k', sleep: noSleep, stateOf: n => ({ n }), concurrency: 2, budgetMs: 60,
      fetch: (_u: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(jsonResponse(okBody(ANSWERS(0.1)))), 40);
        init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal!.reason); });
      }),
    });
    expect(res.stats.answered).toBeGreaterThan(0);
    expect(res.stats.answered).toBeLessThan(20);
    expect(res.stats.answered + res.stats.failed + res.stats.unfinished).toBe(20);
  });
});

describe('receipts fit /models', () => {
  const receipt: DecisionReceipt = {
    kind: 'decision', decisionId: 'test.email', provider: 'openrouter', model: 'typesafe/jev-1.13-20260917',
    usage: { inputTokens: 400, outputTokens: 50, costUsd: 0.00002 }, latencyMs: 212.4, outcome: 'ok', attempts: 1,
  };

  it('toModelsUsage produces a recordUsage input', () => {
    const input: UsageReceipt = toModelsUsage(receipt);
    expect(input).toEqual({
      plan: { planId: null, planSource: 'fallback', model: 'typesafe/jev-1.13-20260917', provider: 'openrouter' },
      kind: 'decision',
      tokens: { input: 400, output: 50 },
      costUsd: 0.00002,
      latencyMs: 212,
      outcome: 'ok',
    });
  });

  it('carries a plan id and tier when the app has one', () => {
    const input = toModelsUsage(receipt, { planId: '00000000-0000-4000-8000-000000000000', tier: 'standard' });
    expect(input.plan).toMatchObject({ planSource: 'default', tier: 'standard' });
    expect(input.kind).toBe('decision');
  });
});
