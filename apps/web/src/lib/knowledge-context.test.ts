import { describe, it, expect } from 'bun:test';
import {
  buildKnowledgeContext,
  buildEntityCatalogContext,
  type KnowledgeQuerier,
  type EntityCatalogFetcher,
} from './knowledge-context';
import type { QueryResult } from '@buildd/core/knowledge-store';

function mockStore(
  byNs: Record<string, Array<Partial<QueryResult>>>,
  countByNs?: Record<string, number>,
): KnowledgeQuerier {
  return {
    async query(ns) {
      return (byNs[ns] ?? []).map((r, i) => ({
        id: r.id ?? `id-${i}`,
        namespace: ns,
        corpus: r.corpus ?? 'memory',
        sourceType: r.sourceType ?? 'memory',
        sourcePath: null,
        sourceUrl: r.sourceUrl ?? null,
        content: r.content ?? '',
        metadata: r.metadata ?? {},
        score: r.score ?? 1,
        createdAt: r.createdAt ?? null,
      })) as QueryResult[];
    },
    countNamespace: countByNs
      ? async (ns) => countByNs[ns] ?? 0
      : undefined,
  };
}

describe('buildKnowledgeContext', () => {
  it('returns [] for an empty query', async () => {
    expect(await buildKnowledgeContext('', 'ws-1', 'team-1', mockStore({}))).toEqual([]);
  });

  it('returns [] when neither workspaceId nor teamId is given', async () => {
    expect(await buildKnowledgeContext('goal', null, null, mockStore({}))).toEqual([]);
  });

  it('returns [] when every source is empty', async () => {
    expect(await buildKnowledgeContext('goal', 'ws-1', 'team-1', mockStore({}))).toEqual([]);
  });

  it('formats retrieved prior work with headers, content, and links', async () => {
    const store = mockStore({
      'team-1:memory': [{ content: '# Codex gotcha\nuses bun', sourceUrl: '/app/memory/m1' }],
      'ws-1:plan': [{ content: '# Plan: build X\nsteps' }],
      'ws-1:task': [], // empty section should be omitted
    });
    const text = (await buildKnowledgeContext('build codex', 'ws-1', 'team-1', store)).join('\n');
    expect(text).toContain('Related prior work');
    expect(text).toContain('Team memory');
    expect(text).toContain('Codex gotcha');
    expect(text).toContain('/app/memory/m1');
    expect(text).toContain('Prior plans');
    expect(text).not.toContain('Past task outcomes'); // omitted when empty
  });

  it('queries the team namespace for memory and workspace namespace for plans/tasks', async () => {
    const seen: string[] = [];
    const store: KnowledgeQuerier = {
      async query(ns) { seen.push(ns); return []; },
    };
    await buildKnowledgeContext('goal', 'ws-1', 'team-1', store);
    expect(seen).toContain('team-1:memory');
    expect(seen).toContain('ws-1:plan');
    expect(seen).toContain('ws-1:task');
  });

  it('also queries pr and code corpora', async () => {
    const seen: string[] = [];
    const store: KnowledgeQuerier = {
      async query(ns) { seen.push(ns); return []; },
    };
    await buildKnowledgeContext('goal', 'ws-1', 'team-1', store);
    expect(seen).toContain('ws-1:pr');
    expect(seen).toContain('ws-1:code');
  });

  it('renders score, status, and age for task hits', async () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    const store = mockStore({
      'ws-1:task': [{
        content: '# Task: Build auth flow\n## Outcome (SUCCESS)\nDone.',
        sourceType: 'task',
        score: 0.91,
        metadata: { success: true, prUrl: 'https://github.com/org/repo/pull/1234' },
        createdAt: recent,
        sourceUrl: '/app/tasks/abc',
      }],
    });
    const text = (await buildKnowledgeContext('auth', 'ws-1', 'team-1', store)).join('\n');
    expect(text).toContain('0.91');
    expect(text).toContain('completed');
    expect(text).toContain('PR #1234');
    expect(text).toContain('2d ago');
  });

  it('renders PR number for pr corpus hits', async () => {
    const store = mockStore({
      'ws-1:pr': [{
        content: '# PR #999: Add new feature\n## Description\nWhatever.',
        sourceType: 'pr',
        score: 0.85,
        metadata: { prNumber: 999, phase: 'implementation' },
        sourceUrl: 'https://github.com/org/repo/pull/999',
      }],
    });
    const text = (await buildKnowledgeContext('new feature', 'ws-1', 'team-1', store)).join('\n');
    expect(text).toContain('Pull requests');
    expect(text).toContain('PR #999');
    expect(text).toContain('0.85');
  });

  it('adds stale-baseline warning for task completed with PR merged within 14 days', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const store = mockStore({
      'ws-1:task': [{
        content: '# Task: Rework Activity IA\n## Outcome (SUCCESS)\nDone.',
        sourceType: 'task',
        score: 0.88,
        metadata: { success: true, prUrl: 'https://github.com/org/repo/pull/1685' },
        createdAt: threeDaysAgo,
      }],
    });
    const text = (await buildKnowledgeContext('activity surface', 'ws-1', 'team-1', store)).join('\n');
    expect(text).toContain('MAY ALREADY BE SHIPPED');
  });

  it('does NOT add stale-baseline warning for task completed 30 days ago', async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const store = mockStore({
      'ws-1:task': [{
        content: '# Task: Rework Activity IA\n## Outcome (SUCCESS)\nDone.',
        sourceType: 'task',
        score: 0.88,
        metadata: { success: true, prUrl: 'https://github.com/org/repo/pull/1685' },
        createdAt: thirtyDaysAgo,
      }],
    });
    const text = (await buildKnowledgeContext('activity surface', 'ws-1', 'team-1', store)).join('\n');
    expect(text).not.toContain('MAY ALREADY BE SHIPPED');
  });

  it('does NOT add stale-baseline warning when task has no prUrl', async () => {
    const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const store = mockStore({
      'ws-1:task': [{
        content: '# Task: Research something\n## Outcome (SUCCESS)\nDone.',
        sourceType: 'task',
        score: 0.90,
        metadata: { success: true },
        createdAt: yesterday,
      }],
    });
    const text = (await buildKnowledgeContext('research', 'ws-1', 'team-1', store)).join('\n');
    expect(text).not.toContain('MAY ALREADY BE SHIPPED');
  });

  it('runs path-based lookup when paths are provided', async () => {
    const seenQueries: Array<{ ns: string; text: string }> = [];
    const store: KnowledgeQuerier = {
      async query(ns, params) {
        seenQueries.push({ ns, text: params.text });
        return [];
      },
    };
    await buildKnowledgeContext('build feature', 'ws-1', 'team-1', store, {
      paths: ['apps/web/src/lib/auth.ts', 'apps/web/src/lib/session.ts'],
    });
    const pathQuery = seenQueries.find(q => q.ns === 'ws-1:pr' && q.text.includes('auth.ts'));
    expect(pathQuery).toBeDefined();
  });

  it('path-based lookup renders a separate section', async () => {
    const store = mockStore({
      'ws-1:pr': [{
        content: '# PR #777: Refactor auth\n## Changed files\n- apps/web/src/lib/auth.ts',
        sourceType: 'pr',
        score: 0.87,
        metadata: { prNumber: 777 },
      }],
    });
    const text = (await buildKnowledgeContext('auth refactor', 'ws-1', 'team-1', store, {
      paths: ['apps/web/src/lib/auth.ts'],
    })).join('\n');
    expect(text).toContain('Recent work on relevant paths');
    expect(text).toContain('PR #777');
  });

  it('skips path-based lookup when paths array is empty', async () => {
    const seen: string[] = [];
    const store: KnowledgeQuerier = {
      async query(ns) { seen.push(ns); return []; },
    };
    await buildKnowledgeContext('build feature', 'ws-1', 'team-1', store, { paths: [] });
    // pr is still queried for the main prior-work pass, but not a second time for path lookup
    const prQueries = seen.filter(ns => ns === 'ws-1:pr');
    expect(prQueries.length).toBe(1); // only the main prior-work query, not the path lookup
  });

  it('gracefully returns [] when store throws', async () => {
    const store: KnowledgeQuerier = {
      async query() { throw new Error('store down'); },
    };
    const result = await buildKnowledgeContext('goal', 'ws-1', 'team-1', store);
    expect(result).toEqual([]);
  });
});

describe('buildKnowledgeContext corpora hint', () => {
  it('includes corpora hint when countNamespace is available', async () => {
    const store = mockStore({}, {
      'team-1:memory': 208,
      'ws-1:code': 12431,
      'ws-1:docs': 340,
    });
    const lines = await buildKnowledgeContext('fix auth bug', 'ws-1', 'team-1', store);
    const text = lines.join('\n');
    expect(text).toContain('knowledge:');
    expect(text).toContain('memory 208');
    expect(text).toContain('code indexed');
    expect(text).toContain('docs 340');
    expect(text).toContain('query_knowledge');
  });

  it('shows code not indexed when no code chunks', async () => {
    const store = mockStore({}, {
      'team-1:memory': 50,
      'ws-1:code': 0,
      'ws-1:docs': 0,
    });
    const text = (await buildKnowledgeContext('task', 'ws-1', 'team-1', store)).join('\n');
    expect(text).toContain('code not indexed');
    expect(text).toContain('docs not indexed');
  });

  it('reports the doc corpus that ingestion actually writes', async () => {
    // The hint read `ws:spec`, which no ingest path writes, so every agent in
    // every workspace was told "spec not indexed" while the docs corpus was
    // being refreshed on every merged PR. A count over a namespace with no
    // writer is not a measurement.
    const store = mockStore({}, {
      'team-1:memory': 10,
      'ws-1:code': 1200,
      'ws-1:docs': 340,
    });
    const text = (await buildKnowledgeContext('task', 'ws-1', 'team-1', store)).join('\n');
    expect(text).toContain('docs 340');
    expect(text).not.toContain('not indexed');
    expect(text).not.toContain('spec');
  });

  it('omits hint when countNamespace is not available', async () => {
    const store: KnowledgeQuerier = {
      async query() { return []; },
    };
    const text = (await buildKnowledgeContext('task', 'ws-1', 'team-1', store)).join('\n');
    expect(text).not.toContain('knowledge:');
  });

  it('hint appears even when no prior work is found', async () => {
    const store = mockStore({}, { 'team-1:memory': 100, 'ws-1:code': 500, 'ws-1:spec': 0 });
    const lines = await buildKnowledgeContext('fix bug', 'ws-1', 'team-1', store);
    const text = lines.join('\n');
    expect(text).toContain('knowledge:');
    expect(text).toContain('memory 100');
  });
});

describe('buildEntityCatalogContext', () => {
  const entities = [
    { kind: 'file', key: 'apps/web/src/lib/pusher.ts', canonicalName: 'pusher.ts' },
    { kind: 'symbol', key: 'apps/web/src/lib/pusher.ts#triggerEvent', canonicalName: 'triggerEvent' },
  ];

  it('returns "" when workspaceId is missing', async () => {
    const fetcher: EntityCatalogFetcher = async () => entities;
    expect(await buildEntityCatalogContext('fix `a/b.ts`', null, fetcher)).toBe('');
    expect(await buildEntityCatalogContext('fix `a/b.ts`', undefined, fetcher)).toBe('');
  });

  it('returns "" when no entities are found', async () => {
    const fetcher: EntityCatalogFetcher = async () => [];
    expect(await buildEntityCatalogContext('fix `a/b.ts`', 'ws-1', fetcher)).toBe('');
  });

  it('passes extracted paths to the fetcher and renders the catalog block', async () => {
    const calls: Array<{ workspaceId: string; paths: string[] }> = [];
    const fetcher: EntityCatalogFetcher = async (workspaceId, paths) => {
      calls.push({ workspaceId, paths });
      return entities;
    };

    const block = await buildEntityCatalogContext(
      'Fix reconnect in `apps/web/src/lib/pusher.ts` after deploy',
      'ws-1',
      fetcher,
    );

    expect(calls).toEqual([{ workspaceId: 'ws-1', paths: ['apps/web/src/lib/pusher.ts'] }]);
    expect(block).toContain('## Known entities');
    expect(block).toContain('file: apps/web/src/lib/pusher.ts');
    expect(block).toContain('symbol: triggerEvent (apps/web/src/lib/pusher.ts#triggerEvent)');
  });

  it('still fetches general vocabulary when the task text has no paths', async () => {
    const calls: Array<string[]> = [];
    const fetcher: EntityCatalogFetcher = async (_ws, paths) => {
      calls.push(paths);
      return [{ kind: 'concept', key: 'auth-flow', canonicalName: 'Auth Flow' }];
    };

    const block = await buildEntityCatalogContext('improve onboarding copy', 'ws-1', fetcher);

    expect(calls).toEqual([[]]);
    expect(block).toContain('concept: Auth Flow (auth-flow)');
  });

  it('returns "" when the fetcher throws (claim must never fail)', async () => {
    const fetcher: EntityCatalogFetcher = async () => {
      throw new Error('store down');
    };
    expect(await buildEntityCatalogContext('fix `a/b.ts`', 'ws-1', fetcher)).toBe('');
  });
});

// ── Clustered retrieval ───────────────────────────────────────────────────────

import {
  buildClusteredKnowledgeContext,
  logContextAssembly,
  type ClusterKeys,
} from './knowledge-context';
import { TOOL_INFRA_ERROR_V1, type ClusterRecipe } from '@buildd/core/retrieval-clusters';

/**
 * Namespace-strict, mode-recording store. Strict on purpose: a fixture that
 * answers every namespace passes identically for `:pr`, `:code`, or a typo,
 * which is exactly how the spec-namespace bug survived its own test.
 */
function clusterStore(byNs: Record<string, Array<Partial<QueryResult>>>) {
  const calls: Array<{ ns: string; text: string; mode?: string; topK?: number }> = [];
  const store: KnowledgeQuerier = {
    async query(ns, params) {
      calls.push({ ns, text: params.text, mode: params.mode, topK: params.topK });
      if (!(ns in byNs)) return [];
      return (byNs[ns] ?? []).map((r, i) => ({
        id: r.id ?? `${ns}-chunk-${i}`,
        namespace: ns,
        corpus: r.corpus ?? 'memory',
        sourceType: r.sourceType ?? 'memory',
        sourcePath: r.sourcePath ?? null,
        sourceUrl: null,
        content: r.content ?? '# hit',
        metadata: {},
        score: r.score ?? 0.9,
        scoreBreakdown: r.scoreBreakdown,
        createdAt: null,
      })) as QueryResult[];
    },
  };
  return { store, calls };
}

const ERROR_TRIGGER = { layer: 'exec' as const, subjectKind: 'error', signature: 'oom_killed' };
const CHAIN = { taskId: 'task-1', workerId: 'worker-1', missionId: null };

function runCluster(
  byNs: Record<string, Array<Partial<QueryResult>>>,
  keys: ClusterKeys = { signature: 'oom_killed', paths: ['apps/runner/src/workers.ts'], pathsDerivedBy: 'path_manifest' },
  opts?: { sensitive?: boolean },
  recipe: ClusterRecipe = TOOL_INFRA_ERROR_V1,
) {
  const { store, calls } = clusterStore(byNs);
  return buildClusteredKnowledgeContext({
    recipe,
    keys,
    workspaceId: 'ws-1',
    teamId: 'team-1',
    trigger: ERROR_TRIGGER,
    chain: CHAIN,
    opts,
    store,
  }).then(res => ({ ...res, calls }));
}

describe('buildClusteredKnowledgeContext — query construction', () => {
  it('keys memory and task steps on the error signature, not the task prose', async () => {
    const { calls } = await runCluster({ 'team-1:memory': [{ content: '# oom gotcha' }] });
    const memory = calls.find(c => c.ns === 'team-1:memory')!;
    const task = calls.find(c => c.ns === 'ws-1:task')!;
    expect(memory.text).toBe('oom_killed');
    expect(task.text).toBe('oom_killed');
  });

  it('scopes memory to the team namespace and everything else to the workspace', async () => {
    const { calls } = await runCluster({});
    expect(calls.map(c => c.ns)).toContain('team-1:memory');
    expect(calls.map(c => c.ns)).toContain('ws-1:task');
    expect(calls.map(c => c.ns)).toContain('ws-1:pr');
    expect(calls.some(c => c.ns === 'ws-1:memory')).toBe(false);
  });

  it('queries the code step lexically and the signature steps hybrid', async () => {
    const { calls } = await runCluster({});
    expect(calls.find(c => c.ns === 'team-1:memory')!.mode).toBe('hybrid');
    expect(calls.find(c => c.ns === 'ws-1:code')!.mode).toBe('lexical');
  });

  it('keys path steps on the paths, one per line', async () => {
    const { calls } = await runCluster({}, {
      signature: 'oom_killed',
      paths: ['apps/runner/src/workers.ts', 'packages/core/db/schema.ts'],
      pathsDerivedBy: 'path_manifest',
    });
    expect(calls.find(c => c.ns === 'ws-1:pr')!.text)
      .toBe('apps/runner/src/workers.ts\npackages/core/db/schema.ts');
  });

  it('never keys a query on the scope-undeclared sentinel', async () => {
    const { calls, assembly } = await runCluster({}, { signature: 'oom_killed', paths: ['**'] });
    expect(calls.some(c => c.text.includes('**'))).toBe(false);
    expect(calls.some(c => c.ns === 'ws-1:pr')).toBe(false);
    expect(assembly.items.find(i => i.step === 3)!.reason).toBe('step_skipped_no_keys');
  });
});

describe('buildClusteredKnowledgeContext — steps are priorities, not exclusions', () => {
  const STRONG = [{ content: '# strong hit', score: 0.9 }];
  const WEAK = [{ content: '# weak hit', score: 0.1 }];

  it('does not run the code step when an earlier step came back strong', async () => {
    const { calls, assembly } = await runCluster({ 'team-1:memory': STRONG });
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(false);
    expect(assembly.weakEscalationFired).toBe(false);
  });

  it('runs the code step when every earlier step came back weak', async () => {
    const { calls, assembly } = await runCluster({
      'team-1:memory': WEAK,
      'ws-1:task': WEAK,
      'ws-1:pr': WEAK,
      'ws-1:code': [{ content: '# workers.ts', score: 0.8 }],
    });
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(true);
    expect(assembly.weakEscalationFired).toBe(true);
    expect(assembly.items.some(i => i.reason === 'touched_file_query_hit')).toBe(true);
  });

  it('counts an empty step as weak, so a silent corpus still escalates', async () => {
    const { calls } = await runCluster({});
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(true);
  });

  it('records step_skipped_no_keys when the escalation has nothing to key on', async () => {
    const { calls, assembly } = await runCluster({}, { signature: 'oom_killed', paths: [] });
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(false);
    const codeItem = assembly.items.find(i => i.step === 4)!;
    expect(codeItem.reason).toBe('step_skipped_no_keys');
    expect(assembly.weakEscalationFired).toBe(false);
  });
});

describe('buildClusteredKnowledgeContext — sensitivity is a recipe change, not a filter', () => {
  it('drops the team memory step, never queries the namespace, and says so', async () => {
    const { calls, assembly } = await runCluster(
      { 'team-1:memory': [{ content: '# should never be read', score: 0.99 }] },
      undefined,
      { sensitive: true },
    );
    expect(calls.some(c => c.ns === 'team-1:memory')).toBe(false);
    expect(assembly.items.find(i => i.step === 1)!.reason).toBe('memory_skipped_sensitive');
  });

  it('still escalates to code, since the dropped step cannot count as strong', async () => {
    const { calls } = await runCluster({}, undefined, { sensitive: true });
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(true);
  });

  it('does not escalate on the skip alone when the surviving steps are strong', async () => {
    // The dropped step must not force escalation either — otherwise every
    // sensitive workspace reaches step 4 unconditionally and the escalation
    // rate stops measuring retrieval quality.
    const { calls } = await runCluster(
      { 'ws-1:task': [{ content: '# strong', score: 0.9 }], 'ws-1:pr': [{ content: '# strong', score: 0.9 }] },
      undefined,
      { sensitive: true },
    );
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(false);
  });
});

describe('buildClusteredKnowledgeContext — the assembly record', () => {
  it('stores references and provenance for each hit', async () => {
    const { assembly } = await runCluster({
      'team-1:memory': [{
        id: 'chunk-abc',
        content: '# oom gotcha\nraise the cap',
        sourcePath: 'docs/runbook.md',
        score: 0.87,
        scoreBreakdown: { dense: 0.81, lexical: 0.44, rrf: 0.031 },
      }],
    });
    const item = assembly.items.find(i => i.chunkId === 'chunk-abc')!;
    expect(item.step).toBe(1);
    expect(item.reason).toBe('error_signature_query_hit');
    expect(item.derivedBy).toBe('subject_anchor');
    expect(item.mode).toBe('hybrid');
    expect(item.rank).toBe(1);
    expect(item.score).toBe(0.87);
    expect(item.scoreBreakdown).toEqual({ dense: 0.81, lexical: 0.44, rrf: 0.031 });
    expect(item.sourcePath).toBe('docs/runbook.md');
  });

  it('NEVER copies retrieved content into the record', async () => {
    const secret = 'a-very-distinctive-chunk-body';
    const { assembly } = await runCluster({ 'team-1:memory': [{ content: `# t\n${secret}` }] });
    expect(JSON.stringify(assembly)).not.toContain(secret);
  });

  it('reads reranker presence off the score breakdown rather than assuming it', async () => {
    const { assembly } = await runCluster({
      'team-1:memory': [{ id: 'r', score: 0.9, scoreBreakdown: { dense: 0.5, rerank: 0.93 } }],
      'ws-1:task': [{ id: 'n', score: 0.9, scoreBreakdown: { dense: 0.5, rrf: 0.02 } }],
    });
    expect(assembly.items.find(i => i.chunkId === 'r')!.reranked).toBe(true);
    expect(assembly.items.find(i => i.chunkId === 'n')!.reranked).toBe(false);
  });

  it('records the derived keys and the trigger that selected the recipe', async () => {
    const { assembly } = await runCluster({});
    expect(assembly.recipe).toBe('tool-infra-error-v1');
    expect(assembly.trigger).toEqual(ERROR_TRIGGER);
    expect(assembly.derivedKeys.signature).toBe('oom_killed');
    expect(assembly.derivedKeys.paths).toEqual(['apps/runner/src/workers.ts']);
    expect(assembly.source).toBe('live');
  });

  it('carries the chain identifiers rather than an outcome field', async () => {
    const { assembly } = await runCluster({});
    expect(assembly.chain).toEqual(CHAIN);
    expect(assembly.assemblyId.length).toBeGreaterThan(0);
  });

  it('distinguishes a query that came back empty from one never issued', async () => {
    // Signature present, so steps 1-2 issue queries and get nothing. No paths,
    // so step 3 is never issued at all. Collapsing these two into one reason
    // would make the fallback rate unreadable.
    const { assembly } = await runCluster({}, { signature: 'oom_killed', paths: [] });
    expect(assembly.items.find(i => i.step === 1)!.reason).toBe('step_query_empty');
    expect(assembly.items.find(i => i.step === 2)!.reason).toBe('step_query_empty');
    expect(assembly.items.find(i => i.step === 3)!.reason).toBe('step_skipped_no_keys');
  });

  it('never records a query_hit for a step that returned nothing', async () => {
    const { assembly } = await runCluster({}, { signature: 'oom_killed', paths: [] });
    for (const item of assembly.items) {
      if (item.reason.endsWith('_query_hit')) expect(item.chunkId).toBeTruthy();
    }
  });

  it('reports the real provenance of the paths, not the step default', async () => {
    const { assembly } = await runCluster({ 'ws-1:pr': [{ id: 'p', score: 0.9 }] }, {
      signature: 'oom_killed',
      paths: ['apps/runner/src/workers.ts'],
      pathsDerivedBy: 'regex_path_extract',
    });
    expect(assembly.items.find(i => i.chunkId === 'p')!.derivedBy).toBe('regex_path_extract');
    // The signature step keeps its own provenance.
    expect(assembly.items.find(i => i.step === 1)!.derivedBy).toBe('subject_anchor');
  });
});

describe('logContextAssembly', () => {
  it('puts the metric fields before the unbounded items array', async () => {
    // A truncated log line is unparseable JSON, so whatever serializes last is
    // what a long assembly loses. The fallback rate must not be what gets lost.
    const { assembly } = await runCluster({
      'team-1:memory': [{ content: '# a' }, { content: '# b' }, { content: '# c' }],
    });
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => { lines.push(msg); };
    try {
      logContextAssembly(assembly);
    } finally {
      console.log = original;
    }

    expect(lines).toHaveLength(1);
    const json = lines[0]!.slice(lines[0]!.indexOf('{'));
    const parsed = JSON.parse(json);
    const order = Object.keys(parsed);
    expect(order[order.length - 1]).toBe('items');
    for (const field of ['recipe', 'fallbackFired', 'weakEscalationFired', 'itemCount']) {
      expect(order.indexOf(field)).toBeGreaterThan(-1);
      expect(order.indexOf(field)).toBeLessThan(order.indexOf('items'));
    }
    // itemCount survives truncation of items, so a clipped line still says how
    // much detail was dropped.
    expect(parsed.itemCount).toBe(assembly.items.length);
  });

  it('never throws, even on a record that cannot be serialized', () => {
    const circular: any = { assemblyId: 'a', recipe: 'r', source: 'live', items: [], chain: {} };
    circular.self = circular;
    expect(() => logContextAssembly(circular)).not.toThrow();
  });
});

describe('buildClusteredKnowledgeContext — rendering, budget, and failure', () => {
  it('renders one labelled section per step that returned something', async () => {
    const { parts } = await runCluster({ 'team-1:memory': [{ content: '# oom gotcha' }] });
    const text = parts.join('\n');
    expect(text).toContain('tool-infra-error-v1');
    expect(text).toContain('Team memory for this error signature');
    expect(text).toContain('oom gotcha');
    expect(text).not.toContain('Past tasks on this error signature');
  });

  it('appends the uncertainty note', async () => {
    const { parts } = await runCluster({ 'team-1:memory': [{ content: '# oom gotcha' }] });
    expect(parts.join('\n')).toContain(TOOL_INFRA_ERROR_V1.uncertaintyNote);
  });

  it('truncates at the section budget instead of growing the prompt', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ content: `# hit ${i} ${'x'.repeat(200)}` }));
    const tight: ClusterRecipe = { ...TOOL_INFRA_ERROR_V1, budgetChars: 300 };
    const { parts } = await runCluster({ 'team-1:memory': many }, undefined, undefined, tight);
    const body = parts.join('\n');
    expect(body).toContain('truncated at the 300-char section budget');
    expect(body.length).toBeLessThan(900);
  });

  it('returns no parts but a usable record when the store throws', async () => {
    const store: KnowledgeQuerier = { async query() { throw new Error('store down'); } };
    const { parts, assembly } = await buildClusteredKnowledgeContext({
      recipe: TOOL_INFRA_ERROR_V1,
      keys: { signature: 'oom_killed' },
      workspaceId: 'ws-1',
      teamId: 'team-1',
      trigger: ERROR_TRIGGER,
      chain: CHAIN,
      store,
    });
    expect(parts).toEqual([]);
    expect(assembly.recipe).toBe('tool-infra-error-v1');
  });

  it('returns no parts when the workspace and team are both unknown', async () => {
    const { store } = clusterStore({});
    const { parts, assembly } = await buildClusteredKnowledgeContext({
      recipe: TOOL_INFRA_ERROR_V1,
      keys: { signature: 'oom_killed' },
      workspaceId: null,
      teamId: null,
      trigger: ERROR_TRIGGER,
      chain: CHAIN,
      store,
    });
    expect(parts).toEqual([]);
    expect(assembly.items.every(i => i.reason === 'step_skipped_no_keys')).toBe(true);
  });
});
