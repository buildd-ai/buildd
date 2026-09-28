/**
 * Conversation titles: the built-in rule, normalisation, the step order
 * (app rule → rule → model), and the reasoning-model regression (a small
 * output cap spent on thinking left every title empty, silently).
 */
import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import type { UsageReceipt } from '@builddai/ai-kit/models';
import {
  DEFAULT_TITLE_LIMITS,
  normalizeTitle,
  ruleTitle,
  titleConversation,
  titleMessages,
} from './index';

const usage = { inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 12, text: 6, reasoning: 6 } };
const answer = (text: string, finish = 'stop') => ({
  content: text ? [{ type: 'reasoning', text: 'thinking…' }, { type: 'text', text }] : [{ type: 'reasoning', text: 'thinking…' }],
  finishReason: { unified: finish, raw: finish }, usage, warnings: [],
});
const plan = { planId: 'p1', planSource: 'registry', provider: 'openrouter', model: 'budget/model', tier: 'budget' } as const;
const long = 'I need help figuring out why the nightly export keeps failing after the schema change we shipped';
const convo = (first: string) => [
  { role: 'user', text: first },
  { role: 'assistant', text: 'The export fails on a missing column.' },
];

describe('ruleTitle', () => {
  it('takes a short first message as the title, minus filler', () => {
    expect(ruleTitle('can you check why the release is stuck?')).toBe('Check why the release is stuck?');
    expect(ruleTitle('hey, stalled missions')).toBe('Stalled missions');
    expect(ruleTitle('Plan the Q4 roadmap.')).toBe('Plan the Q4 roadmap');
  });

  it('abstains on one word, long, multi-line, code or links', () => {
    expect(ruleTitle('help')).toBeNull();
    expect(ruleTitle(long)).toBeNull();
    expect(ruleTitle('fix this\nplease')).toBeNull();
    expect(ruleTitle('why does `foo()` fail')).toBeNull();
    expect(ruleTitle('look at https://example.com now')).toBeNull();
  });
});

describe('normalizeTitle', () => {
  it('strips labels, quotes, markdown and a trailing period; first line only', () => {
    expect(normalizeTitle('Title: "Nightly export failures".')).toBe('Nightly export failures');
    expect(normalizeTitle('**Export failures**\nextra')).toBe('Export failures');
    expect(normalizeTitle('   ')).toBeNull();
    expect(normalizeTitle(42)).toBeNull();
    expect(normalizeTitle('x'.repeat(120))!.length).toBe(80);
  });
});

describe('titleMessages', () => {
  it('reads text parts of user and assistant messages only', () => {
    const out = titleMessages([
      { role: 'user', parts: [{ type: 'text', text: 'hi there' }] },
      { role: 'event', parts: [{ type: 'text', text: 'x' }] },
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 'hello' }] },
    ]);
    expect(out).toEqual([{ role: 'user', text: 'hi there' }, { role: 'assistant', text: 'hello' }]);
  });
});

describe('titleConversation', () => {
  it('an app rule wins before the built-in rule and the model', async () => {
    let called = false;
    const r = await titleConversation({
      messages: convo('Why is it stuck?'),
      rules: () => 'Multi-currency invoices',
      model: () => { called = true; return null; },
    });
    expect(r).toEqual({ title: 'Multi-currency invoices', source: 'app_rule' });
    expect(called).toBe(false);
  });

  it('the built-in rule needs no model', async () => {
    expect(await titleConversation({ messages: convo('why is the release stuck?') })).toEqual({ title: 'Why is the release stuck?', source: 'rule' });
  });

  it('asks the model for a long first message, with room for reasoning, and sends a receipt', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => answer('Nightly export failures') as never });
    const receipts: UsageReceipt[] = [];
    const r = await titleConversation({ messages: convo(long), model: { model, plan, recordUsage: x => receipts.push(x) } });
    expect(r).toEqual({ title: 'Nightly export failures', source: 'model' });
    expect(model.doGenerateCalls[0].maxOutputTokens).toBe(DEFAULT_TITLE_LIMITS.maxOutputTokens);
    expect(DEFAULT_TITLE_LIMITS.maxOutputTokens).toBeGreaterThanOrEqual(256);
    expect(receipts).toMatchObject([{ kind: 'inference', outcome: 'ok', tokens: { input: 40, output: 12 }, plan: { model: 'budget/model' } }]);
  });

  it('regression: a reasoning model that spends the cap returns no title, and says so', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => answer('', 'length') as never });
    const errors: unknown[] = [];
    const receipts: UsageReceipt[] = [];
    const r = await titleConversation({ messages: convo(long), model: { model, plan, recordUsage: x => receipts.push(x) }, onError: e => errors.push(e) });
    expect(r).toBeNull();
    expect(String(errors[0])).toContain('returned no text (finish: length');
    expect(receipts[0].outcome).toBe('error');
  });

  it('rules only when no model is given; a throwing model never throws out', async () => {
    expect(await titleConversation({ messages: convo(long) })).toBeNull();
    const errors: unknown[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('boom'); } });
    expect(await titleConversation({ messages: convo(long), model: { model }, onError: e => errors.push(e) })).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('skipBuiltInRule sends a short message to the model', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => answer('Release status') as never });
    const r = await titleConversation({ messages: convo('why is the release stuck?'), skipBuiltInRule: true, model: { model } });
    expect(r).toEqual({ title: 'Release status', source: 'model' });
  });
});
