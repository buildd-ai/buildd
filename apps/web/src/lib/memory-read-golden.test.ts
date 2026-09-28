/**
 * Golden outputs for the web-side memory read paths, captured BEFORE memory
 * reads were routed through `retrieveMemory` (task d1997424).
 *
 * The refactor is a no-op by contract: every snapshot below was recorded
 * against the pre-refactor code and must not change. A diff here means an
 * agent now sees different memory than it did, which is a product change and
 * needs its own flag, not a silent drift inside a plumbing PR.
 */
import { describe, it, expect } from 'bun:test';
import {
  buildKnowledgeContext,
  buildClusteredKnowledgeContext,
  type KnowledgeQuerier,
} from './knowledge-context';
import type { QueryResult } from '@buildd/core/knowledge-store';
import type { MemoryHitScope } from '@buildd/core/memory-hit-scope';
import { TOOL_INFRA_ERROR_V1, MIN_STRONG_BY_SIGNAL } from '@buildd/core/retrieval-clusters';

const OWN = 'acme/widgets';
const DAY = 24 * 60 * 60 * 1000;

function scope(projects: Record<string, string | null> = {}, count = 7): MemoryHitScope {
  return {
    project: OWN,
    lookup: async (ids) => ({ memories: ids.map(id => ({ id, project: id in projects ? projects[id] : OWN })) }),
    count: async () => count,
  };
}

type Row = Partial<QueryResult> & { id: string };

function store(byNs: Record<string, Row[]>, counts: Record<string, number> = {}) {
  const calls: Array<{ ns: string; text: string; topK?: number; mode?: string }> = [];
  const ks: KnowledgeQuerier = {
    async query(ns, params) {
      calls.push({ ns, text: params.text, topK: params.topK, mode: params.mode });
      const corpus = ns.split(':')[1] as QueryResult['corpus'];
      return (byNs[ns] ?? []).map(r => ({
        namespace: ns,
        corpus,
        sourceType: corpus,
        sourcePath: null,
        sourceUrl: null,
        content: '# hit',
        metadata: {},
        score: 0.5,
        createdAt: null,
        ...r,
      })) as QueryResult[];
    },
    countNamespace: async (ns) => counts[ns] ?? 0,
  };
  return { ks, calls };
}

const FIXTURE: Record<string, Row[]> = {
  'team-1:memory': [
    { id: 'm-own-1', content: '# Neon has no transactions\nuse UPDATE WHERE', score: 0.8, sourceUrl: '/app/memory/m-own-1', createdAt: new Date(Date.now() - 3 * DAY) },
    { id: 'm-foreign', content: '# Foreign memory\nnot yours', score: 0.9, sourceUrl: '/app/memory/m-foreign' },
    { id: 'm-own-weak', content: '# Weak memory', score: 0.2 },
    { id: 'm-own-2', content: '# Second own memory', score: 0.5, sourceUrl: '/app/memory/m-own-2' },
    { id: 'm-own-3', content: '# Third own memory', score: 0.47 },
  ],
  'ws-1:plan': [{ id: 'p1', content: '# Plan: ship it', score: 0.6 }],
  'ws-1:task': [
    { id: 't1', content: '# Task: Build auth\n## Outcome', score: 0.9, sourceType: 'task', metadata: { success: true, prUrl: 'https://github.com/o/r/pull/12' }, createdAt: new Date(Date.now() - 2 * DAY), sourceUrl: '/app/tasks/t1' },
    { id: 't-excluded', content: '# Task: excluded', score: 0.9, sourceType: 'task' },
  ],
  'ws-1:pr': [{ id: 'pr1', content: '# PR #7: thing', score: 0.7, sourceType: 'pr', metadata: { prNumber: 7 } }],
  'ws-1:code': [{ id: 'c1', content: 'function x() {}', score: 0.3 }],
};

describe('golden: buildKnowledgeContext (claim-time fan-out, mission planning)', () => {
  it('renders the full five-corpus block, hint, and path lookup unchanged', async () => {
    const { ks, calls } = store(FIXTURE, { 'ws-1:code': 1234, 'ws-1:docs': 5 });
    const parts = await buildKnowledgeContext('build auth', 'ws-1', 'team-1', ks, {
      paths: ['apps/web/src/a.ts', 'apps/web/src/b.ts'],
      excludedSourceIds: new Set(['t-excluded']),
      memoryScope: scope({ 'm-foreign': 'acme/other' }),
    });
    expect(parts).toMatchInlineSnapshot(`
      [
        "knowledge: memory 7 · code indexed (1,234 chunks) · docs 5 — recall before diagnosing",
        
      "
      ## Related prior work (retrieved from knowledge base)"
      ,
        
      "
      ### Team memory"
      ,
        "- [0.80] | Neon has no transactions | 3d ago (/app/memory/m-own-1)",
        "- [0.50] | Second own memory (/app/memory/m-own-2)",
        
      "
      ### Prior plans"
      ,
        "- [0.60] | Plan: ship it",
        
      "
      ### Past task outcomes"
      ,
        "- [0.90] | Task: Build auth | completed | PR #12 | 2d ago (/app/tasks/t1)",
        "  ⚠ MAY ALREADY BE SHIPPED — read the merged diff before specing. Merged code may not be released, so the UI is not evidence.",
        
      "
      ### Pull requests"
      ,
        "- [0.70] | PR #7: thing | PR #7",
        
      "
      ## Recent work on relevant paths"
      ,
        "- [0.70] | PR #7: thing | PR #7",
      ]
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "mode": undefined,
          "ns": "team-1:memory",
          "text": "build auth",
          "topK": 15,
        },
        {
          "mode": undefined,
          "ns": "ws-1:plan",
          "text": "build auth",
          "topK": 3,
        },
        {
          "mode": undefined,
          "ns": "ws-1:task",
          "text": "build auth",
          "topK": 3,
        },
        {
          "mode": undefined,
          "ns": "ws-1:pr",
          "text": "build auth",
          "topK": 3,
        },
        {
          "mode": undefined,
          "ns": "ws-1:code",
          "text": "build auth",
          "topK": 3,
        },
        {
          "mode": undefined,
          "ns": "ws-1:pr",
          "text": 
      "apps/web/src/a.ts
      apps/web/src/b.ts"
      ,
          "topK": 3,
        },
      ]
    `);
  });

  it('renders no memory section and no memory count with a null scope', async () => {
    const { ks, calls } = store(FIXTURE, { 'ws-1:code': 0 });
    const parts = await buildKnowledgeContext('build auth', 'ws-1', 'team-1', ks, { memoryScope: null });
    expect(parts).toMatchInlineSnapshot(`
      [
        "knowledge: code not indexed · docs not indexed — recall before diagnosing",
        
      "
      ## Related prior work (retrieved from knowledge base)"
      ,
        
      "
      ### Prior plans"
      ,
        "- [0.60] | Plan: ship it",
        
      "
      ### Past task outcomes"
      ,
        "- [0.90] | Task: Build auth | completed | PR #12 | 2d ago (/app/tasks/t1)",
        "  ⚠ MAY ALREADY BE SHIPPED — read the merged diff before specing. Merged code may not be released, so the UI is not evidence.",
        "- [0.90] | Task: excluded | task",
        
      "
      ### Pull requests"
      ,
        "- [0.70] | PR #7: thing | PR #7",
      ]
    `);
    expect(calls.map(c => c.ns)).toMatchInlineSnapshot(`
      [
        "ws-1:plan",
        "ws-1:task",
        "ws-1:pr",
        "ws-1:code",
      ]
    `);
  });

  it('skips memory for a sensitive workspace', async () => {
    const { ks, calls } = store(FIXTURE);
    const parts = await buildKnowledgeContext('build auth', 'ws-1', 'team-1', ks, { sensitive: true, memoryScope: scope() });
    expect(parts.join('\n')).not.toContain('Team memory');
    expect(calls.map(c => c.ns)).not.toContain('team-1:memory');
  });
});

describe('golden: buildClusteredKnowledgeContext (claim-time recipe)', () => {
  const STRONG = MIN_STRONG_BY_SIGNAL.rerank + 0.2;
  it('renders the recipe block and records the same assembly items', async () => {
    const { ks, calls } = store({
      'team-1:memory': [
        { id: 'm-own-1', content: '# OOM gotcha', score: STRONG * 0.5, scoreBreakdown: { rerank: STRONG } },
        { id: 'm-foreign', content: '# Foreign OOM', score: 0.9, scoreBreakdown: { rerank: 0.9 } },
        { id: 't-excluded', content: '# excluded memory', score: 0.4, scoreBreakdown: { rerank: 0.8 } },
      ],
      'ws-1:task': [{ id: 't1', content: '# Task: oom', score: 0.3, scoreBreakdown: { rerank: 0.75 }, sourceType: 'task' }],
    }, { 'ws-1:code': 10 });
    const { parts, assembly } = await buildClusteredKnowledgeContext({
      recipe: TOOL_INFRA_ERROR_V1,
      keys: { signature: 'oom_killed', paths: ['apps/runner/src/workers.ts'], pathsDerivedBy: 'path_manifest' },
      workspaceId: 'ws-1',
      teamId: 'team-1',
      trigger: { layer: 'exec', subjectKind: 'error', signature: 'oom_killed' },
      chain: { taskId: 'task-1', workerId: 'worker-1', missionId: null },
      opts: { memoryScope: scope({ 'm-foreign': 'acme/other' }), excludedSourceIds: new Set(['t-excluded']) },
      store: ks,
    });
    expect(parts).toMatchInlineSnapshot(`
      [
        "knowledge: memory 7 · code indexed (10 chunks) · docs not indexed — recall before diagnosing",
        
      "
      ## Related prior work — tool-infra-error-v1"
      ,
        
      "
      ### Team memory for this error signature"
      ,
        "- [0.35] | OOM gotcha",
        
      "
      ### Past tasks on this error signature"
      ,
        "- [0.30] | Task: oom | task",
        
      "
      _Retrieved by error signature, not by diagnosis. A prior occurrence of the same signature may have had a different cause; scores surface candidates, they do not decide._"
      ,
      ]
    `);
    expect(assembly.items).toMatchInlineSnapshot(`
      [
        {
          "chunkId": "t1",
          "corpus": "task",
          "derivedBy": "subject_anchor",
          "graphProximity": undefined,
          "modeRequested": "hybrid",
          "namespace": "ws-1:task",
          "rank": 1,
          "reason": "error_signature_query_hit",
          "rerankApplied": true,
          "score": 0.3,
          "scoreBreakdown": {
            "dense": undefined,
            "lexical": undefined,
            "rerank": 0.75,
            "rrf": undefined,
          },
          "signals": [
            "rerank",
          ],
          "sourcePath": null,
          "step": 2,
          "strength": 0.75,
          "strengthSignal": "rerank",
        },
        {
          "corpus": "pr",
          "derivedBy": "path_manifest",
          "modeRequested": "hybrid",
          "namespace": "ws-1:pr",
          "reason": "step_query_empty",
          "step": 3,
        },
        {
          "chunkId": "m-own-1",
          "corpus": "memory",
          "derivedBy": "subject_anchor",
          "graphProximity": undefined,
          "modeRequested": "hybrid",
          "namespace": "team-1:memory",
          "rank": 1,
          "reason": "error_signature_query_hit",
          "rerankApplied": true,
          "score": 0.35,
          "scoreBreakdown": {
            "dense": undefined,
            "lexical": undefined,
            "rerank": 0.7,
            "rrf": undefined,
          },
          "signals": [
            "rerank",
          ],
          "sourcePath": null,
          "step": 1,
          "strength": 0.7,
          "strengthSignal": "rerank",
        },
        {
          "corpus": "code",
          "derivedBy": "path_manifest",
          "reason": "step_skipped_priors_strong",
          "step": 4,
        },
      ]
    `);
    expect(calls).toMatchInlineSnapshot(`
      [
        {
          "mode": "hybrid",
          "ns": "team-1:memory",
          "text": "oom_killed",
          "topK": 15,
        },
        {
          "mode": "hybrid",
          "ns": "ws-1:task",
          "text": "oom_killed",
          "topK": 3,
        },
        {
          "mode": "hybrid",
          "ns": "ws-1:pr",
          "text": "apps/runner/src/workers.ts",
          "topK": 3,
        },
      ]
    `);
  });
});
