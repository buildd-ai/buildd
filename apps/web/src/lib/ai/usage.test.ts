import { describe, it, expect } from 'bun:test';
import { validateUsageRecord, validateUsageBody, receiptCost, MAX_USAGE_RECORDS } from './usage';

const PLAN = '22222222-2222-4222-8222-222222222222';
const rec = { planId: PLAN, tokens: { input: 1200, output: 300 }, latencyMs: 850, outcome: 'ok' };

describe('validateUsageRecord', () => {
  it('accepts a minimal receipt tied to a plan', () => {
    const v = validateUsageRecord(rec);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value).toEqual({
      planId: PLAN, model: null, provider: null, tier: null, planSource: null,
      tokens: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 },
      costUsd: null, latencyMs: 850, outcome: 'ok', feedback: null,
    });
  });

  it('accepts every metadata field', () => {
    const v = validateUsageRecord({
      ...rec, model: 'anthropic/claude-sonnet-5', provider: 'openrouter', tier: 'standard', planSource: 'cached',
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 0.0012, outcome: 'aborted', feedback: 'down',
    });
    expect(v.ok).toBe(true);
  });

  // The design's P1 acceptance criterion: any field outside the metadata schema is rejected.
  it.each([
    'prompt', 'messages', 'content', 'text', 'response', 'completion', 'system',
    'userId', 'subject', 'email', 'user', 'tenantId', 'conversationId', 'metadata',
  ])('rejects a receipt carrying %s', (field) => {
    const v = validateUsageRecord({ ...rec, [field]: 'anything' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain(`unknown field(s): ${field}`);
  });

  it('rejects content hidden inside tokens', () => {
    expect(validateUsageRecord({ ...rec, tokens: { input: 1, output: 1, text: 'hi' } }).ok).toBe(false);
  });

  it('rejects prose in the model field', () => {
    expect(validateUsageRecord({ ...rec, model: 'my user asked about their rent' }).ok).toBe(false);
    expect(validateUsageRecord({ ...rec, model: 'x'.repeat(200) }).ok).toBe(false);
  });

  it('requires model, provider and tier when there is no plan', () => {
    const noPlan = { ...rec, planId: null };
    expect(validateUsageRecord(noPlan).ok).toBe(false);
    expect(validateUsageRecord({ ...noPlan, model: 'claude-haiku-4-5', provider: 'anthropic', tier: 'budget', planSource: 'fallback' }).ok).toBe(true);
  });

  it.each([
    [{ ...rec, planId: 'plan-1' }, 'planId'],
    [{ ...rec, tokens: { input: 1.5, output: 1 } }, 'tokens'],
    [{ ...rec, tokens: { input: -1, output: 1 } }, 'tokens'],
    [{ ...rec, tokens: undefined }, 'tokens'],
    [{ ...rec, costUsd: -1 }, 'costUsd'],
    [{ ...rec, costUsd: 'free' }, 'costUsd'],
    [{ ...rec, latencyMs: -3 }, 'latencyMs'],
    [{ ...rec, outcome: 'great' }, 'outcome'],
    [{ ...rec, feedback: 'loved it' }, 'feedback'],
    [{ ...rec, provider: 'openai-codex' }, 'provider'],
    [{ ...rec, tier: 'gold' }, 'tier'],
    [{ ...rec, planSource: 'mine' }, 'planSource'],
  ])('rejects %j', (body, field) => {
    const v = validateUsageRecord(body);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain(field);
  });
});

describe('validateUsageBody', () => {
  it('takes a single receipt', () => {
    const v = validateUsageBody(rec);
    expect(v.ok && v.value.length).toBe(1);
  });

  it('takes a batch', () => {
    const v = validateUsageBody({ records: [rec, { ...rec, outcome: 'error' }] });
    expect(v.ok && v.value.map((r) => r.outcome)).toEqual(['ok', 'error']);
  });

  it('rejects the whole batch when one receipt is bad, naming it', () => {
    const v = validateUsageBody({ records: [rec, { ...rec, prompt: 'x' }] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toStartWith('records[1]: unknown field(s): prompt');
  });

  it('rejects extra keys beside records, empty and oversized batches', () => {
    expect(validateUsageBody({ records: [rec], userId: 'u' }).ok).toBe(false);
    expect(validateUsageBody({ records: [] }).ok).toBe(false);
    expect(validateUsageBody({ records: Array.from({ length: MAX_USAGE_RECORDS + 1 }, () => rec) }).ok).toBe(false);
    expect(validateUsageBody('receipt').ok).toBe(false);
  });
});

describe('receiptCost', () => {
  const p = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

  it('uses the reported cost when there is one', () => {
    const v = validateUsageRecord({ ...rec, costUsd: 0.5 });
    if (!v.ok) throw new Error(v.error);
    expect(receiptCost(v.value, p)).toEqual({ costUsd: 0.5, costSource: 'reported' });
  });

  it('estimates from list price otherwise, cache tokens included', () => {
    const v = validateUsageRecord({ ...rec, tokens: { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0 } });
    if (!v.ok) throw new Error(v.error);
    expect(receiptCost(v.value, p)).toEqual({ costUsd: 3.2, costSource: 'estimated' });
  });
});
