/**
 * Claim-time memory as an index (task caa30c0f). Flag off is pinned by
 * memory-read-golden.test.ts (byte-identical); this file pins flag on: the
 * memory section becomes one header plus one line per memory, the other
 * corpora render as before, the budget holds, and the ledger records what the
 * budget left out.
 */
import { describe, it, expect } from 'bun:test';
import {
  buildKnowledgeContext,
  buildClusteredKnowledgeContext,
  type KnowledgeQuerier,
} from './knowledge-context';
import type { QueryResult } from '@buildd/core/knowledge-store';
import type { MemoryHitScope } from '@buildd/core/memory-hit-scope';
import type { MemoryUseRow } from '@buildd/core/memory-retrieval';
import { MEMORY_INDEX_HEADER, type MemoryIndexEntry } from '@buildd/core/memory-claim-index';
import { TOOL_INFRA_ERROR_V1, MIN_STRONG_BY_SIGNAL } from '@buildd/core/retrieval-clusters';

const OWN = 'acme/widgets';
const TEAM = '11111111-1111-4111-8111-111111111111';
const M1 = '1a2b3c4d-0000-4000-8000-000000000001';
const M2 = '2b3c4d5e-0000-4000-8000-000000000002';
const M3 = '3c4d5e6f-0000-4000-8000-000000000003';

const TITLES: Record<string, { title: string; type: string }> = {
  [M1]: { title: 'Neon has no transactions', type: 'gotcha' },
  [M2]: { title: 'Use bun run test', type: 'pattern' },
};

function scope(): MemoryHitScope {
  return {
    project: OWN,
    lookup: async (ids) => ({ memories: ids.map(id => ({ id, project: OWN, ...(TITLES[id] ?? {}) })) }),
    count: async () => 3,
  };
}

type Row = Partial<QueryResult> & { id: string };
function store(byNs: Record<string, Row[]>): KnowledgeQuerier {
  return {
    async query(ns) {
      const corpus = ns.split(':')[1] as QueryResult['corpus'];
      return (byNs[ns] ?? []).map(r => ({
        namespace: ns, corpus, sourceType: corpus, sourcePath: null, sourceUrl: null,
        content: '# hit', metadata: {}, score: 0.5, createdAt: null, ...r,
      })) as QueryResult[];
    },
    countNamespace: async () => 0,
  };
}

const FIXTURE: Record<string, Row[]> = {
  [`${TEAM}:memory`]: [
    { id: M1, content: 'Body one, long enough to matter '.repeat(10), score: 0.8, metadata: { type: 'gotcha' }, sourceUrl: `/app/memory/${M1}` },
    { id: M2, content: 'Body two', score: 0.6, metadata: { type: 'pattern' } },
    { id: M3, content: '# Fallback title from body\nmore', score: 0.5, metadata: { type: 'decision' } },
  ],
  'ws-1:plan': [{ id: 'p1', content: '# Plan: ship it', score: 0.6 }],
};

describe('buildKnowledgeContext, index mode', () => {
  it('renders the memory section as an index and leaves other corpora alone', async () => {
    let entries: MemoryIndexEntry[] = [];
    const parts = await buildKnowledgeContext('build auth', 'ws-1', TEAM, store(FIXTURE), {
      memoryScope: scope(),
      ledger: false,
      memoryIndex: { budgetTokens: 800, onEntries: e => { entries = e; } },
    });
    const text = parts.join('\n');
    expect(text).toContain([
      '### Team memory',
      MEMORY_INDEX_HEADER,
      '- gotcha m:1a2b3c4d Neon has no transactions (title)',
      '- pattern m:2b3c4d5e Use bun run test (title)',
      '- decision m:3c4d5e6f Fallback title from body (title)',
    ].join('\n'));
    expect(text).not.toContain('Body one');
    expect(text).toContain('- [0.60] | Plan: ship it');
    expect(entries.map(e => e.id)).toEqual([M1, M2, M3]);
  });

  it('holds the token budget and ledgers what it left out as char_budget', async () => {
    const batches: MemoryUseRow[][] = [];
    let entries: MemoryIndexEntry[] = [];
    const parts = await buildKnowledgeContext('build auth', 'ws-1', TEAM, store(FIXTURE), {
      memoryScope: scope(),
      ledger: rows => { batches.push(rows); },
      memoryIndex: { budgetTokens: 40, onEntries: e => { entries = e; } },
    });
    expect(parts.join('\n')).toContain('m:1a2b3c4d');
    expect(parts.join('\n')).not.toContain('m:3c4d5e6f');
    expect(entries.map(e => e.id)).toEqual([M1]);
    expect(batches).toHaveLength(1);
    expect(batches[0].map(r => [r.memoryId, r.gatedBy])).toEqual([[M1, null], [M2, 'char_budget'], [M3, 'char_budget']]);
    expect(batches[0].every(r => r.via === 'push')).toBe(true);
  });

  it('without the option renders bodies exactly as before', async () => {
    const off = await buildKnowledgeContext('build auth', 'ws-1', TEAM, store(FIXTURE), { memoryScope: scope(), ledger: false });
    expect(off.join('\n')).not.toContain(MEMORY_INDEX_HEADER);
    expect(off.join('\n')).toContain('- [0.80] | Body one');
  });
});

describe('buildClusteredKnowledgeContext, index mode', () => {
  const STRONG = MIN_STRONG_BY_SIGNAL.rerank + 0.2;
  it('renders the recipe memory step as index lines, why = signature', async () => {
    let entries: MemoryIndexEntry[] = [];
    const { parts } = await buildClusteredKnowledgeContext({
      recipe: TOOL_INFRA_ERROR_V1,
      keys: { signature: 'oom_killed', paths: ['apps/runner/src/workers.ts'], pathsDerivedBy: 'path_manifest' },
      workspaceId: 'ws-1',
      teamId: TEAM,
      trigger: { layer: 'exec', subjectKind: 'error', signature: 'oom_killed' },
      chain: { taskId: 'task-1', workerId: 'worker-1', missionId: null },
      opts: { memoryScope: scope(), ledger: false, memoryIndex: { budgetTokens: 800, onEntries: e => { entries = e; } } },
      store: store({
        [`${TEAM}:memory`]: [{ id: M1, content: 'OOM body', score: 0.5, scoreBreakdown: { rerank: STRONG } }],
        'ws-1:task': [{ id: 't1', content: '# Task: oom', score: 0.3, scoreBreakdown: { rerank: 0.75 }, sourceType: 'task' }],
      }),
    });
    const text = parts.join('\n');
    expect(text).toContain(`### Team memory for this error signature\n${MEMORY_INDEX_HEADER}\n- gotcha m:1a2b3c4d Neon has no transactions (signature)`);
    expect(text).not.toContain('OOM body');
    expect(text).toContain('- [0.30] | Task: oom | task');
    expect(entries.map(e => e.id)).toEqual([M1]);
  });

  it('a recipe with two memory steps carries one header and each memory once', async () => {
    const recipe = {
      ...TOOL_INFRA_ERROR_V1,
      steps: [
        TOOL_INFRA_ERROR_V1.steps[0],
        { ...TOOL_INFRA_ERROR_V1.steps[0], step: 2, label: 'Team memory for these paths', keyKind: 'paths' as const, derivedBy: 'path_manifest' as const },
      ],
    };
    const { parts } = await buildClusteredKnowledgeContext({
      recipe,
      keys: { signature: 'oom_killed', paths: ['apps/runner/src/workers.ts'], pathsDerivedBy: 'path_manifest' },
      workspaceId: 'ws-1',
      teamId: TEAM,
      trigger: { layer: 'exec', subjectKind: 'error', signature: 'oom_killed' },
      chain: { taskId: 'task-1', workerId: 'worker-1', missionId: null },
      opts: { memoryScope: scope(), ledger: false, memoryIndex: { budgetTokens: 800 } },
      store: store({
        [`${TEAM}:memory`]: [
          { id: M1, content: 'OOM body', score: 0.5, scoreBreakdown: { rerank: STRONG } },
          { id: M2, content: 'Other body', score: 0.5, scoreBreakdown: { rerank: STRONG } },
        ],
      }),
    });
    const text = parts.join('\n');
    expect(text.split(MEMORY_INDEX_HEADER)).toHaveLength(2);
    expect(text.match(/m:1a2b3c4d/g)).toHaveLength(1);
    expect(text.match(/m:2b3c4d5e/g)).toHaveLength(1);
    // The header sits directly above the first index line.
    expect(text).toContain(`${MEMORY_INDEX_HEADER}\n- gotcha m:1a2b3c4d`);
  });
});
