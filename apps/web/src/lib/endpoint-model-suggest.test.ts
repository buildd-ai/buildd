/**
 * Decision-model suggestions for endpoint model rows nothing deterministic
 * matched (docs/design/agent-model-endpoint.md §4). Suggestions only: the
 * caller shows them flagged; nothing here stores anything. Fixtures are
 * illustrative.
 */
import { describe, expect, it } from 'bun:test';
import {
  ENDPOINT_MODEL_SUGGEST_CAPABILITY,
  SUGGEST_MIN_CONFIDENCE,
  suggestEndpointModels,
} from './endpoint-model-suggest';

const okAccess = async () => ({ ok: true as const, apiKey: 'sk-decision-example', model: 'jev' });
const LISTED = ['team-fast', 'team-smart', 'gpt-4o-mini'];
const base = { teamId: 't', workspaceId: null, userId: 'u', listed: LISTED, models: ['claude-haiku-4-5-20251001'] };

function decideWith(pick: (labels: string[]) => { choice: string; confidence: number } | 'fail') {
  const calls: any[] = [];
  const decide = (async (p: any) => {
    calls.push(p);
    const labels = Object.keys(p.questions.pick.criteria);
    const r = pick(labels);
    if (r === 'fail') return { ok: false, error: { kind: 'timeout' }, latencyMs: 1, attempts: 1 };
    p.onUsage?.({ decisionId: p.decisionId });
    return { ok: true, answers: { pick: { type: 'choice', choice: r.choice, confidence: r.confidence, probabilities: {} } }, model: 'jev', usage: {}, latencyMs: 1, attempts: 1 };
  }) as any;
  return { calls, decide };
}

describe('suggestEndpointModels', () => {
  it('a confident pick comes back as a suggestion with its confidence, and the receipt is recorded', async () => {
    const receipts: any[] = [];
    const d = decideWith(() => ({ choice: 'team-fast', confidence: 0.91 }));
    const r = await suggestEndpointModels(base, { decide: d.decide, resolveAccess: okAccess, recordReceipt: async (x) => { receipts.push(x); }, log: () => {} });
    expect(r).toEqual([{ model: 'claude-haiku-4-5-20251001', suggested: 'team-fast', confidence: 0.91 }]);
    expect(d.calls[0].capability).toBe(ENDPOINT_MODEL_SUGGEST_CAPABILITY);
    // The label set is the endpoint's own ids, nothing else.
    expect(Object.keys(d.calls[0].questions.pick.criteria).sort()).toEqual([...LISTED].sort());
    expect(JSON.stringify(d.calls[0].state)).toContain('claude-haiku-4-5-20251001');
    expect(receipts).toHaveLength(1);
  });

  it('below the confidence threshold: nothing', async () => {
    const d = decideWith(() => ({ choice: 'team-fast', confidence: SUGGEST_MIN_CONFIDENCE - 0.01 }));
    expect(await suggestEndpointModels(base, { decide: d.decide, resolveAccess: okAccess, recordReceipt: async () => {}, log: () => {} })).toEqual([]);
  });

  it('a failed call, a throw, or no decision model configured: nothing, silently', async () => {
    const failed = decideWith(() => 'fail');
    expect(await suggestEndpointModels(base, { decide: failed.decide, resolveAccess: okAccess, recordReceipt: async () => {}, log: () => {} })).toEqual([]);
    const thrown = (async () => { throw new Error('boom'); }) as any;
    expect(await suggestEndpointModels(base, { decide: thrown, resolveAccess: okAccess, recordReceipt: async () => {}, log: () => {} })).toEqual([]);
    const none = decideWith(() => ({ choice: 'team-fast', confidence: 0.99 }));
    const r = await suggestEndpointModels(base, {
      decide: none.decide,
      resolveAccess: async () => ({ ok: false, error: { kind: 'missing_key' } }) as any,
      recordReceipt: async () => {},
      log: () => {},
    });
    expect(r).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });

  it('caps candidates and models, drops junk ids, needs two candidates', async () => {
    const d = decideWith((labels) => ({ choice: labels[0], confidence: 0.95 }));
    const listed = [...Array.from({ length: 60 }, (_, i) => `m-${i}`), 'has space'];
    const models = Array.from({ length: 20 }, (_, i) => `claude-x-${i}`);
    await suggestEndpointModels({ ...base, listed, models }, { decide: d.decide, resolveAccess: okAccess, recordReceipt: async () => {}, log: () => {} });
    expect(d.calls.length).toBeLessThanOrEqual(8);
    for (const c of d.calls) {
      const labels = Object.keys(c.questions.pick.criteria);
      expect(labels.length).toBeLessThanOrEqual(20);
      expect(labels).not.toContain('has space');
    }
    const one = decideWith(() => ({ choice: 'only', confidence: 0.99 }));
    expect(await suggestEndpointModels({ ...base, listed: ['only'] }, { decide: one.decide, resolveAccess: okAccess, recordReceipt: async () => {}, log: () => {} })).toEqual([]);
    expect(one.calls).toHaveLength(0);
  });
});
