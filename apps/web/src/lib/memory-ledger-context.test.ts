/**
 * Claim-time and planning memory reads go through retrieveMemory: each writes
 * one ledger batch under its caller, records what its gates held back, and
 * counts no hits, for memory or any other corpus (task d1997424).
 */
import { describe, it, expect } from 'bun:test';
import { buildKnowledgeContext, buildClusteredKnowledgeContext, type KnowledgeQuerier } from './knowledge-context';
import type { QueryResult } from '@buildd/core/knowledge-store';
import type { MemoryHitScope } from '@buildd/core/memory-hit-scope';
import type { MemoryUseRow } from '@buildd/core/memory-retrieval';
import { TOOL_INFRA_ERROR_V1, MIN_STRONG_BY_SIGNAL, type ClusterRecipe } from '@buildd/core/retrieval-clusters';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const WORKER = '44444444-4444-4444-8444-444444444444';
const OWN = 'acme/widgets';

const scope: MemoryHitScope = {
  project: OWN,
  lookup: async ids => ({ memories: ids.map(id => ({ id, project: OWN })) }),
};

function store(byNs: Record<string, Array<Partial<QueryResult> & { id: string }>>) {
  const calls: Array<{ ns: string; trackHits?: boolean }> = [];
  const ks: KnowledgeQuerier = {
    async query(ns, params) {
      calls.push({ ns, trackHits: params.trackHits });
      const corpus = ns.split(':')[1] as QueryResult['corpus'];
      return (byNs[ns] ?? []).map(r => ({
        namespace: ns, corpus, sourceType: corpus, sourcePath: null, sourceUrl: null,
        content: `# ${r.id}`, metadata: {}, score: 0.5, createdAt: null, ...r,
      })) as QueryResult[];
    },
  };
  return { ks, calls };
}

function recorder() {
  const batches: MemoryUseRow[][] = [];
  return { batches, ledger: (rows: MemoryUseRow[]) => { batches.push(rows); } };
}

describe('buildKnowledgeContext ledger', () => {
  it('one batch per retrieval, gated rows named, attribution carried, no hits counted', async () => {
    const { ks, calls } = store({
      [`${TEAM}:memory`]: [{ id: 'm-shown', score: 0.8 }, { id: 'm-handoff', score: 0.9 }, { id: 'm-weak', score: 0.1 }],
      [`${WS}:task`]: [{ id: 't1', score: 0.9 }],
    });
    const { batches, ledger } = recorder();
    const text = (await buildKnowledgeContext('q', WS, TEAM, ks, {
      memoryScope: scope,
      excludedSourceIds: new Set(['m-handoff']),
      paths: ['a.ts'],
      attribution: { taskId: TASK, workerId: WORKER },
      ledger,
    })).join('\n');
    expect(text).toContain('m-shown');
    expect(text).not.toContain('m-handoff');
    expect(text).not.toContain('m-weak');
    expect(batches).toHaveLength(1);
    expect(batches[0].map(r => [r.memoryId, r.gatedBy, r.caller, r.via, r.taskId, r.workerId])).toEqual([
      ['m-shown', null, 'claim_context', 'push', TASK, WORKER],
      ['m-handoff', 'excluded', 'claim_context', 'push', TASK, WORKER],
      ['m-weak', 'score_floor', 'claim_context', 'push', TASK, WORKER],
    ]);
    // Memory is measured by the ledger, so its push is not a hit. The other
    // corpora have no ledger yet and keep counting (trackHits left default).
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.filter(c => c.ns.endsWith(':memory')).map(c => c.trackHits)).toEqual([false]);
    expect(calls.filter(c => !c.ns.endsWith(':memory')).every(c => c.trackHits === undefined)).toBe(true);
  });

  it('mission planning records under its own caller', async () => {
    const { ks } = store({ [`${TEAM}:memory`]: [{ id: 'm1', score: 0.8 }] });
    const { batches, ledger } = recorder();
    await buildKnowledgeContext('q', WS, TEAM, ks, { memoryScope: scope, caller: 'mission_planning', ledger });
    expect(batches[0][0]).toMatchObject({ memoryId: 'm1', caller: 'mission_planning', via: 'push', taskId: null });
  });

  it('starts the fan-out without waiting on the corpora hint', async () => {
    const order: string[] = [];
    let releaseCount!: () => void;
    const countGate = new Promise<void>(r => { releaseCount = r; });
    const ks: KnowledgeQuerier = {
      async query(ns) { order.push(`query ${ns.split(':')[1]}`); return []; },
      async countNamespace(ns) { order.push(`count ${ns.split(':')[1]}`); await countGate; return 0; },
    };
    const slowScope: MemoryHitScope = { ...scope, count: async () => { order.push('count memory'); await countGate; return 0; } };
    const done = buildKnowledgeContext('q', WS, TEAM, ks, { memoryScope: slowScope, ledger: false });
    await new Promise(r => setTimeout(r, 5));
    // The queries ran while every count was still blocked.
    expect(order.filter(o => o.startsWith('query'))).toHaveLength(5);
    releaseCount();
    const parts = await done;
    expect(parts[0]).toBe('knowledge: memory 0 · code not indexed · docs not indexed — recall before diagnosing');
  });
});

describe('buildClusteredKnowledgeContext ledger', () => {
  const STRONG = MIN_STRONG_BY_SIGNAL.rerank + 0.2;
  const run = (byNs: Parameters<typeof store>[0], recipe: ClusterRecipe = TOOL_INFRA_ERROR_V1) => {
    const { ks, calls } = store(byNs);
    const { batches, ledger } = recorder();
    return buildClusteredKnowledgeContext({
      recipe,
      keys: { signature: 'oom_killed', paths: ['a.ts'], pathsDerivedBy: 'path_manifest' },
      workspaceId: WS, teamId: TEAM,
      trigger: { layer: 'exec', subjectKind: 'error', signature: 'oom_killed' },
      chain: { taskId: TASK, workerId: WORKER, missionId: null },
      opts: { memoryScope: scope, ledger },
      store: ks,
    }).then(r => ({ ...r, batches, calls }));
  };

  it('records shown memory under claim_recipe; memory counts no hit, other corpora still do', async () => {
    const { batches, calls, parts } = await run({
      [`${TEAM}:memory`]: [{ id: 'm1', score: 0.4, scoreBreakdown: { rerank: STRONG } }],
    });
    expect(parts.join('\n')).toContain('m1');
    expect(batches).toEqual([[expect.objectContaining({ memoryId: 'm1', caller: 'claim_recipe', via: 'push', gatedBy: null, taskId: TASK })]]);
    expect(calls.filter(c => c.ns.endsWith(':memory')).map(c => c.trackHits)).toEqual([false]);
    expect(calls.filter(c => !c.ns.endsWith(':memory')).every(c => c.trackHits === undefined)).toBe(true);
  });

  it('shown-or-dropped is decided by hit id, not by rendered text', async () => {
    // Two memory hits that render to the identical line; the budget keeps
    // only the first. Matching on text would call both shown.
    const same = { content: '# same title', score: 0.4, scoreBreakdown: { rerank: STRONG } };
    const tight: ClusterRecipe = { ...TOOL_INFRA_ERROR_V1, budgetChars: 75 };
    const { batches, parts } = await run({
      [`${TEAM}:memory`]: [{ id: 'm-a', ...same }, { id: 'm-b', ...same }],
    }, tight);
    expect(parts.join('\n').match(/same title/g)).toHaveLength(1);
    expect(batches[0].map(r => [r.memoryId, r.gatedBy])).toEqual([['m-a', null], ['m-b', 'char_budget']]);
  });

  it('marks memory the char budget dropped', async () => {
    const tight: ClusterRecipe = { ...TOOL_INFRA_ERROR_V1, budgetChars: 60 };
    const { batches } = await run({
      [`${TEAM}:memory`]: [
        { id: 'm1', content: '# first', score: 0.4, scoreBreakdown: { rerank: STRONG } },
        { id: 'm2', content: '# second hit that will not fit the budget', score: 0.3, scoreBreakdown: { rerank: STRONG } },
      ],
    }, tight);
    expect(batches[0].map(r => [r.memoryId, r.gatedBy])).toEqual([['m1', null], ['m2', 'char_budget']]);
  });

  it('marks every memory hit when the recipe falls back to the fan-out', async () => {
    const none: ClusterRecipe = { ...TOOL_INFRA_ERROR_V1, budgetChars: 1 };
    const { batches, parts, assembly } = await run({
      [`${TEAM}:memory`]: [{ id: 'm1', score: 0.4, scoreBreakdown: { rerank: STRONG } }],
    }, none);
    expect(parts).toEqual([]);
    expect(assembly.fallbackFired).toBe(true);
    expect(batches[0].map(r => [r.memoryId, r.gatedBy])).toEqual([['m1', 'recipe_fallback']]);
  });
});
