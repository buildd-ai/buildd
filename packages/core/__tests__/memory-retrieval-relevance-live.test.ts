/**
 * The live relevance gate in retrieveMemory (task 58eea487): on a retrieval
 * that opts in (claim_context), confident "not relevant" hits move below the
 * others inside a hard budget. Nothing is ever removed, a mandatory hit is
 * never moved, and any failure or timeout leaves the rule order.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  retrieveMemory,
  setMemoryRelevanceJudge,
  setMemoryRelevanceShadow,
  type MemoryRelevanceJudgeInput,
  type MemoryRelevanceShadowInput,
  type MemoryUseRow,
} from '../memory-retrieval';
import type { MemoryHitScope, MemoryQuerier } from '../memory-hit-scope';
import type { QueryResult } from '../knowledge-store/types';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const OWN = 'acme/widgets';

const scope: MemoryHitScope = { project: OWN, lookup: async ids => ({ memories: ids.map(id => ({ id, project: OWN })) }) };
const ks: MemoryQuerier = {
  async query(ns) {
    return [
      { id: 'm1', score: 0.9, metadata: {} },
      { id: 'm2', score: 0.8, metadata: { pinned: true } },
      { id: 'm3', score: 0.7, metadata: { tags: ['gotcha'] } },
      { id: 'm4', score: 0.2, metadata: {} },
    ].map(r => ({ namespace: ns, corpus: 'memory', sourceType: 'memory', sourcePath: null, sourceUrl: null, content: `body ${r.id}`, createdAt: null, isCurrent: true, ...r })) as QueryResult[];
  },
};

const base = {
  query: 'fix the claim route',
  scope: { teamId: TEAM, workspaceId: WS, memoryScope: scope },
  budget: { topK: 5 },
  store: ks,
  ledger: false as const,
  gate: { minScore: 0.45 },
  caller: 'claim_context' as const,
  attribution: { taskId: TASK },
};
const live = { live: true, mandatory: (r: QueryResult) => r.metadata.pinned === true };

function judge(demote: string[], opts: { delayMs?: number } = {}) {
  const calls: MemoryRelevanceJudgeInput[] = [];
  const recorded: boolean[] = [];
  setMemoryRelevanceJudge(async (input) => {
    calls.push(input);
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
    return { demote: new Set(demote), record: (applied) => { recorded.push(applied); } };
  });
  return { calls, recorded };
}

afterEach(() => {
  setMemoryRelevanceJudge(null);
  setMemoryRelevanceShadow(null);
});

describe('live relevance gate', () => {
  it('moves a confident not-relevant hit below the others, never removing it', async () => {
    const j = judge(['m1']);
    const res = await retrieveMemory({ ...base, relevance: live });
    expect(res.results.map(r => r.id)).toEqual(['m2', 'm3', 'm1']);
    expect(res.hits.filter(h => !h.gated).map(h => [h.memoryId, h.rank])).toEqual([['m2', 1], ['m3', 2], ['m1', 3]]);
    // The gated hit stays in the list, below every shown one.
    expect(res.hits.map(h => h.memoryId)).toEqual(['m2', 'm3', 'm1', 'm4']);
    expect(j.recorded).toEqual([true]);
  });

  it('sends the shown hits with the mandatory flag, and never demotes a mandatory hit', async () => {
    const j = judge(['m2', 'm3']);
    const res = await retrieveMemory({ ...base, relevance: live });
    expect(j.calls[0].hits.map(h => [h.memoryId, h.mandatory])).toEqual([['m1', false], ['m2', true], ['m3', false]]);
    expect(j.calls[0].budgetMs).toBeGreaterThan(0);
    expect(res.results.map(r => r.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('by default, a pinned or directive-tagged memory is mandatory', async () => {
    const tagged: MemoryQuerier = {
      async query(ns) {
        return (await ks.query(ns, { text: '' })).map(r => (r.id === 'm1' ? { ...r, metadata: { tags: ['directive'] } } : r));
      },
    };
    const j = judge(['m1', 'm2']);
    const res = await retrieveMemory({ ...base, store: tagged, relevance: { live: true } });
    expect(j.calls[0].hits.map(h => h.mandatory)).toEqual([true, true, false]);
    expect(res.results.map(r => r.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('the ledger records the order the agent was shown', async () => {
    judge(['m1']);
    const rows: MemoryUseRow[] = [];
    await retrieveMemory({ ...base, ledger: r => { rows.push(...r); }, relevance: live });
    expect(rows.filter(r => r.gatedBy === null).map(r => [r.memoryId, r.rank])).toEqual([['m2', 1], ['m3', 2], ['m1', 3]]);
  });

  it('past the budget: the rule order, and the verdicts log as not applied', async () => {
    const j = judge(['m1'], { delayMs: 120 });
    const res = await retrieveMemory({ ...base, relevance: { ...live, budgetMs: 20 } });
    expect(res.results.map(r => r.id)).toEqual(['m1', 'm2', 'm3']);
    expect(j.recorded).toEqual([]);
    await new Promise(r => setTimeout(r, 200));
    expect(j.recorded).toEqual([false]);
  });

  it('a judge that throws or returns null leaves the rule order', async () => {
    setMemoryRelevanceJudge(async () => { throw new Error('boom'); });
    expect((await retrieveMemory({ ...base, relevance: live })).results.map(r => r.id)).toEqual(['m1', 'm2', 'm3']);
    setMemoryRelevanceJudge(() => { throw new Error('sync boom'); });
    expect((await retrieveMemory({ ...base, relevance: live })).results.map(r => r.id)).toEqual(['m1', 'm2', 'm3']);
    setMemoryRelevanceJudge(async () => null);
    expect((await retrieveMemory({ ...base, relevance: live })).results.map(r => r.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('only for a retrieval that opts in: other callers keep the sampled shadow and are never judged', async () => {
    const j = judge(['m1']);
    const seen: MemoryRelevanceShadowInput[] = [];
    setMemoryRelevanceShadow(i => { seen.push(i); });
    const res = await retrieveMemory({ ...base, caller: 'claim_recipe' });
    expect(j.calls).toHaveLength(0);
    expect(res.results.map(r => r.id)).toEqual(['m1', 'm2', 'm3']);
    expect(seen).toHaveLength(1);
  });

  it('a judged retrieval does not also run the shadow; an unjudged one (null) does', async () => {
    const seen: MemoryRelevanceShadowInput[] = [];
    setMemoryRelevanceShadow(i => { seen.push(i); });
    judge([]);
    await retrieveMemory({ ...base, relevance: live });
    expect(seen).toHaveLength(0);
    setMemoryRelevanceJudge(async () => null);
    await retrieveMemory({ ...base, relevance: live });
    expect(seen).toHaveLength(1);
  });

  it('skips pulls, unattributed retrievals and a single shown hit (no order to change)', async () => {
    const j = judge(['m1']);
    await retrieveMemory({ ...base, caller: 'recall', relevance: live });
    await retrieveMemory({ ...base, attribution: undefined, relevance: live });
    await retrieveMemory({ ...base, budget: { topK: 1 }, relevance: live });
    expect(j.calls).toHaveLength(0);
  });
});
