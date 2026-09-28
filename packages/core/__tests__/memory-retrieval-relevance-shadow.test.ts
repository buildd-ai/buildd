/**
 * The relevance shadow hook in retrieveMemory (task 66ddcb3c): it sees every
 * pushed, task-attributed retrieval's shown hits and never changes a result.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  retrieveMemory,
  setMemoryRelevanceShadow,
  type MemoryRelevanceShadowInput,
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
      { id: 'm1', score: 0.9 },
      { id: 'm2', score: 0.3 },
    ].map(r => ({ namespace: ns, corpus: 'memory', sourceType: 'memory', sourcePath: null, sourceUrl: null, content: `body ${r.id}`, metadata: {}, createdAt: null, isCurrent: true, ...r })) as QueryResult[];
  },
};

const base = {
  query: 'fix the claim route',
  scope: { teamId: TEAM, workspaceId: WS, memoryScope: scope },
  budget: { topK: 5 },
  store: ks,
  ledger: false as const,
  gate: { minScore: 0.45 },
};

afterEach(() => { setMemoryRelevanceShadow(null); });

describe('relevance shadow hook', () => {
  it('receives the shown hits of a pushed, task-attributed retrieval', async () => {
    const seen: MemoryRelevanceShadowInput[] = [];
    setMemoryRelevanceShadow(i => { seen.push(i); });
    await retrieveMemory({ ...base, caller: 'claim_context', attribution: { taskId: TASK } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ teamId: TEAM, workspaceId: WS, taskId: TASK, caller: 'claim_context', query: 'fix the claim route' });
    expect(seen[0].hits.map(h => [h.memoryId, h.content, h.gatedBy])).toEqual([['m1', 'body m1', null]]);
  });

  it('does not change results, even when the hook throws', async () => {
    const plain = await retrieveMemory({ ...base, caller: 'claim_context', attribution: { taskId: TASK } });
    setMemoryRelevanceShadow(() => { throw new Error('boom'); });
    const hooked = await retrieveMemory({ ...base, caller: 'claim_context', attribution: { taskId: TASK } });
    expect(hooked.results.map(r => r.id)).toEqual(plain.results.map(r => r.id));
    expect(hooked.hits.map(h => h.gatedBy)).toEqual(plain.hits.map(h => h.gatedBy));
  });

  it('skips pulls and retrievals with no task', async () => {
    const seen: MemoryRelevanceShadowInput[] = [];
    setMemoryRelevanceShadow(i => { seen.push(i); });
    await retrieveMemory({ ...base, caller: 'recall', attribution: { taskId: TASK } });
    await retrieveMemory({ ...base, caller: 'claim_context' });
    expect(seen).toHaveLength(0);
  });

  it('runs once, at ledger commit, with the post-processing gate applied', async () => {
    const seen: MemoryRelevanceShadowInput[] = [];
    setMemoryRelevanceShadow(i => { seen.push(i); });
    const res = await retrieveMemory({ ...base, caller: 'claim_recipe', attribution: { taskId: TASK }, deferLedger: true });
    expect(seen).toHaveLength(0);
    res.commitLedger(h => (h.memoryId === 'm1' ? 'char_budget' : null));
    res.commitLedger();
    expect(seen).toHaveLength(0);
  });
});
