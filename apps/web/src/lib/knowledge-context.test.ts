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
  buildFanOutAssembly,
  logContextAssembly,
  type ClusterKeys,
} from './knowledge-context';
import {
  TOOL_INFRA_ERROR_V1,
  MIN_STRONG_BY_SIGNAL,
  ASSEMBLY_LOG_PREFIX,
  ASSEMBLY_ITEMS_LOG_PREFIX,
  DEFAULT_FAN_OUT_RECIPE,
  type ClusterRecipe,
} from '@buildd/core/retrieval-clusters';

/**
 * A hit shaped like one the real pipeline produces.
 *
 * `score` is deliberately set to the post-decay value the store would return —
 * `relevance × CORPUS_AUTHORITY[corpus]` — so no test can pass by handing the
 * predicate a number the pipeline cannot generate. The first version of these
 * tests used `score: 0.9` on the `task` corpus, whose live ceiling is 0.4, and
 * that fixture is what hid an always-weak weakness gate.
 */
function hit(opts: {
  id?: string;
  corpus?: QueryResult['corpus'];
  rerank?: number;
  rrf?: number;
  content?: string;
  sourcePath?: string | null;
  sourceUrl?: string | null;
  graphProximity?: number;
  createdAt?: Date | null;
  sourceType?: string;
  metadata?: Record<string, unknown>;
}): Partial<QueryResult> {
  const authority: Record<string, number> = { memory: 0.5, task: 0.4, pr: 0.5, code: 0.8 };
  const relevance = opts.rerank ?? opts.rrf ?? 0.5;
  const breakdown: QueryResult['scoreBreakdown'] = {};
  if (opts.rerank !== undefined) breakdown.rerank = opts.rerank;
  if (opts.rrf !== undefined) breakdown.rrf = opts.rrf;
  return {
    id: opts.id,
    corpus: opts.corpus,
    content: opts.content ?? '# hit',
    sourcePath: opts.sourcePath ?? null,
    sourceUrl: opts.sourceUrl ?? null,
    sourceType: opts.sourceType,
    metadata: opts.metadata,
    createdAt: opts.createdAt ?? null,
    graphProximity: opts.graphProximity,
    score: relevance * (authority[opts.corpus ?? 'memory'] ?? 1),
    scoreBreakdown: Object.keys(breakdown).length > 0 ? breakdown : undefined,
  };
}

const STRONG = MIN_STRONG_BY_SIGNAL.rerank + 0.2;
const WEAK = MIN_STRONG_BY_SIGNAL.rerank - 0.2;

/**
 * Namespace-strict, call-recording store. Strict on purpose: a fixture that
 * answers every namespace passes identically for `:pr`, `:code`, or a typo,
 * which is how the spec-namespace bug survived its own test.
 */
function clusterStore(byNs: Record<string, Array<Partial<QueryResult>>>) {
  const calls: Array<{ ns: string; text: string; mode?: string; topK?: number }> = [];
  const store: KnowledgeQuerier = {
    async query(ns, params) {
      calls.push({ ns, text: params.text, mode: params.mode, topK: params.topK });
      if (!(ns in byNs)) return [];
      const corpus = ns.split(':')[1] as QueryResult['corpus'];
      return (byNs[ns] ?? []).map((r, i) => ({
        namespace: ns,
        corpus: r.corpus ?? corpus,
        sourceType: r.sourceType ?? corpus,
        sourceUrl: r.sourceUrl ?? null,
        sourcePath: r.sourcePath ?? null,
        content: r.content ?? '# hit',
        metadata: r.metadata ?? {},
        score: r.score ?? 0.5,
        createdAt: r.createdAt ?? null,
        ...r,
        id: r.id ?? `${ns}-chunk-${i}`,
      })) as QueryResult[];
    },
  };
  return { store, calls };
}

const ERROR_TRIGGER = { layer: 'exec' as const, subjectKind: 'error', signature: 'oom_killed' };
const CHAIN = { taskId: 'task-1', workerId: 'worker-1', missionId: null };
const DEFAULT_KEYS: ClusterKeys = {
  signature: 'oom_killed',
  paths: ['apps/runner/src/workers.ts'],
  pathsDerivedBy: 'path_manifest',
};

function runCluster(
  byNs: Record<string, Array<Partial<QueryResult>>>,
  keys: ClusterKeys = DEFAULT_KEYS,
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

/** All four unconditional-step namespaces weak, so step 4's gate opens. */
const ALL_WEAK = {
  'team-1:memory': [hit({ corpus: 'memory', rerank: WEAK })],
  'ws-1:task': [hit({ corpus: 'task', rerank: WEAK })],
  'ws-1:pr': [hit({ corpus: 'pr', rerank: WEAK })],
};

function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => { lines.push(String(msg)); };
  try { fn(); } finally { console.log = original; }
  return lines;
}

describe('buildClusteredKnowledgeContext — query construction', () => {
  it('keys memory and task steps on the error signature, not the task prose', async () => {
    const { calls } = await runCluster({ 'team-1:memory': [hit({ content: '# oom gotcha' })] });
    expect(calls.find(c => c.ns === 'team-1:memory')!.text).toBe('oom_killed');
    expect(calls.find(c => c.ns === 'ws-1:task')!.text).toBe('oom_killed');
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

  it('never keys a query on whitespace, and never claims it derived one', async () => {
    const { calls, assembly } = await runCluster({}, {
      signature: '  oom_killed  ',
      paths: ['   ', '\t', ''],
      pathsDerivedBy: 'path_manifest',
    });
    expect(calls.some(c => c.ns === 'ws-1:pr')).toBe(false);
    expect(calls.find(c => c.ns === 'team-1:memory')!.text).toBe('oom_killed');
    // The record must show the keys actually queried, or a cohort join against
    // the task row silently mismatches.
    expect(assembly.derivedKeys.paths).toEqual([]);
  });

  it('dedupes and caps recorded paths to what it queried', async () => {
    const { calls, assembly } = await runCluster({}, {
      signature: 'oom_killed',
      paths: ['a/b.ts', 'a/b.ts', ...Array.from({ length: 30 }, (_, i) => `p/${i}.ts`)],
      pathsDerivedBy: 'path_manifest',
    });
    const queried = calls.find(c => c.ns === 'ws-1:pr')!.text.split('\n');
    expect(assembly.derivedKeys.paths).toEqual(queried);
    expect(queried.length).toBe(20);
    expect(new Set(queried).size).toBe(20);
  });
});

describe('buildClusteredKnowledgeContext — steps are priorities, not exclusions', () => {
  it('does not run the code step when an earlier step came back strong', async () => {
    const { calls, assembly } = await runCluster({
      'team-1:memory': [hit({ corpus: 'memory', rerank: STRONG })],
      'ws-1:task': [hit({ corpus: 'task', rerank: STRONG })],
      'ws-1:pr': [hit({ corpus: 'pr', rerank: STRONG })],
    });
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(false);
    expect(assembly.weakEscalationFired).toBe(false);
    // The fourth outcome: without this row, "the gate held" is
    // indistinguishable from "this recipe has no step 4".
    expect(assembly.items.find(i => i.step === 4)!.reason).toBe('step_skipped_priors_strong');
  });

  it('a single strong step is enough to hold the gate', async () => {
    const { calls } = await runCluster({
      ...ALL_WEAK,
      'ws-1:task': [hit({ corpus: 'task', rerank: STRONG })],
    });
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(false);
  });

  it('runs the code step when every earlier step came back weak', async () => {
    const { calls, assembly } = await runCluster({
      ...ALL_WEAK,
      'ws-1:code': [hit({ corpus: 'code', rerank: STRONG, content: '# workers.ts' })],
    });
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(true);
    expect(assembly.weakEscalationFired).toBe(true);
    expect(assembly.items.some(i => i.reason === 'touched_file_query_hit')).toBe(true);
  });

  it('is strength that opens the gate, not the corpus authority in `score`', async () => {
    // A task hit at maximum relevance has score 0.4 because task authority is
    // 0.4. The old predicate thresholded that at 0.5 and called it weak, which
    // made escalation unconditional. It must now hold the gate.
    const { calls } = await runCluster({
      ...ALL_WEAK,
      'ws-1:task': [hit({ corpus: 'task', rerank: 1 })],
    });
    const taskHit = hit({ corpus: 'task', rerank: 1 });
    expect(taskHit.score).toBeCloseTo(0.4, 5);
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(false);
  });

  it('counts an empty step as weak, so a silent corpus still escalates', async () => {
    const { calls } = await runCluster({});
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(true);
  });

  it('records the escalation even when the escalated step has no key', async () => {
    // The gate opening and the query succeeding are different events. This is
    // the recipe's most likely failure mode, so it must not read as "no
    // escalation happened".
    const { calls, assembly } = await runCluster({}, { signature: 'oom_killed', paths: [] });
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(false);
    expect(assembly.items.find(i => i.step === 4)!.reason).toBe('step_skipped_no_keys');
    expect(assembly.weakEscalationFired).toBe(true);
  });

  it('runs the unconditional steps concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const store: KnowledgeQuerier = {
      async query() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        return [];
      },
    };
    await buildClusteredKnowledgeContext({
      recipe: TOOL_INFRA_ERROR_V1,
      keys: DEFAULT_KEYS,
      workspaceId: 'ws-1',
      teamId: 'team-1',
      trigger: ERROR_TRIGGER,
      chain: CHAIN,
      store,
    });
    expect(peak).toBeGreaterThan(1);
  });
});

describe('buildClusteredKnowledgeContext — graph neighbours do not claim the key', () => {
  it('gives an entity-walk neighbour its own reason and records proximity', async () => {
    // The store appends 1-hop entity neighbours to every query. Stamping them
    // with the step's reason would assert "a query keyed on the error signature
    // returned this", which is false — an entity edge returned it.
    const { assembly } = await runCluster({
      'team-1:memory': [
        hit({ id: 'seed', corpus: 'memory', rerank: STRONG, graphProximity: 1 }),
        hit({ id: 'neighbour', corpus: 'memory', rerank: STRONG, graphProximity: 0.6 }),
      ],
    });
    expect(assembly.items.find(i => i.chunkId === 'seed')!.reason).toBe('error_signature_query_hit');
    expect(assembly.items.find(i => i.chunkId === 'neighbour')!.reason).toBe('graph_expansion_hit');
    expect(assembly.items.find(i => i.chunkId === 'neighbour')!.graphProximity).toBe(0.6);
  });

  it('does not let a neighbour satisfy a step, since the key did not return it', async () => {
    const { calls } = await runCluster({
      'team-1:memory': [hit({ corpus: 'memory', rerank: STRONG, graphProximity: 0.6 })],
      'ws-1:task': [hit({ corpus: 'task', rerank: STRONG, graphProximity: 0.6 })],
      'ws-1:pr': [hit({ corpus: 'pr', rerank: STRONG, graphProximity: 0.6 })],
    });
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(true);
  });

  it('treats an absent proximity as a seed, since expansion may be off', async () => {
    const { assembly } = await runCluster({
      'team-1:memory': [hit({ id: 'plain', corpus: 'memory', rerank: STRONG })],
    });
    expect(assembly.items.find(i => i.chunkId === 'plain')!.reason).toBe('error_signature_query_hit');
  });
});

describe('buildClusteredKnowledgeContext — sensitivity is a recipe change, not a filter', () => {
  it('drops the team memory step, never queries the namespace, and says so', async () => {
    const { calls, assembly } = await runCluster(
      { 'team-1:memory': [hit({ rerank: 0.99, content: '# should never be read' })] },
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
    const { calls } = await runCluster(
      {
        'ws-1:task': [hit({ corpus: 'task', rerank: STRONG })],
        'ws-1:pr': [hit({ corpus: 'pr', rerank: STRONG })],
      },
      undefined,
      { sensitive: true },
    );
    expect(calls.some(c => c.ns === 'ws-1:code')).toBe(false);
  });
});

describe('buildClusteredKnowledgeContext — the assembly record', () => {
  it('stores references and provenance for each hit', async () => {
    const { assembly } = await runCluster({
      'team-1:memory': [hit({
        id: 'chunk-abc',
        corpus: 'memory',
        rerank: 0.87,
        rrf: 0.031,
        content: '# oom gotcha\nraise the cap',
        sourcePath: 'docs/runbook.md',
      })],
    });
    const item = assembly.items.find(i => i.chunkId === 'chunk-abc')!;
    expect(item.step).toBe(1);
    expect(item.reason).toBe('error_signature_query_hit');
    expect(item.derivedBy).toBe('subject_anchor');
    expect(item.modeRequested).toBe('hybrid');
    expect(item.rank).toBe(1);
    expect(item.sourcePath).toBe('docs/runbook.md');
    expect(item.strength).toBe(0.87);
    expect(item.strengthSignal).toBe('rerank');
    expect(item.signals).toEqual(['rerank', 'rrf']);
  });

  it('records the namespace, not just the corpus, so the join is unambiguous', async () => {
    // knowledge_chunks is unique on (namespace, source_id) and source_ids are
    // composite `path#line` values, so the same id exists in every workspace's
    // :code namespace. chunkId + corpus alone is an ambiguous join, not merely
    // a dangling one.
    const { assembly } = await runCluster({ 'team-1:memory': [hit({ id: 'c', rerank: STRONG })] });
    expect(assembly.items.find(i => i.chunkId === 'c')!.namespace).toBe('team-1:memory');
    expect(assembly.workspaceId).toBe('ws-1');
    expect(assembly.teamId).toBe('team-1');
  });

  it('NEVER copies retrieved content into the record', async () => {
    const secret = 'a-very-distinctive-chunk-body';
    const { assembly } = await runCluster({ 'team-1:memory': [hit({ content: `# t\n${secret}` })] });
    expect(JSON.stringify(assembly)).not.toContain(secret);
  });

  it('reports rerank presence per item, not per configuration', async () => {
    // _finalize reranks only when more than one result came back, so a
    // single-hit step legitimately carries no rerank score with a reranker
    // fully configured. Reading this field as "no reranker" would be wrong.
    const { assembly } = await runCluster({
      'team-1:memory': [hit({ id: 'r', rerank: STRONG })],
      'ws-1:task': [hit({ id: 'n', corpus: 'task', rrf: 0.02 })],
    });
    expect(assembly.items.find(i => i.chunkId === 'r')!.rerankApplied).toBe(true);
    expect(assembly.items.find(i => i.chunkId === 'n')!.rerankApplied).toBe(false);
    expect(assembly.items.find(i => i.chunkId === 'n')!.strengthSignal).toBe('rrf');
  });

  it('records the trigger, the timestamp, and the chain rather than an outcome', async () => {
    const { assembly } = await runCluster({});
    expect(assembly.recipe).toBe('tool-infra-error-v1');
    expect(assembly.trigger).toEqual(ERROR_TRIGGER);
    expect(assembly.chain).toEqual(CHAIN);
    expect(assembly.source).toBe('live');
    expect(assembly.assemblyId.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(assembly.at))).toBe(true);
  });

  it('reports the real provenance of the paths, not the step default', async () => {
    const { assembly } = await runCluster({ 'ws-1:pr': [hit({ id: 'p', corpus: 'pr', rerank: STRONG })] }, {
      signature: 'oom_killed',
      paths: ['apps/runner/src/workers.ts'],
      pathsDerivedBy: 'pattern_component_table',
    });
    expect(assembly.items.find(i => i.chunkId === 'p')!.derivedBy).toBe('pattern_component_table');
    expect(assembly.items.find(i => i.step === 1)!.derivedBy).toBe('subject_anchor');
  });

  it('emits exactly one row per step that produced no hits', async () => {
    const { assembly } = await runCluster({}, { signature: 'oom_killed', paths: [] });
    // 1 and 2 ran and came back empty; 3 and 4 had no key to run with.
    expect(assembly.items.find(i => i.step === 1)!.reason).toBe('step_query_empty');
    expect(assembly.items.find(i => i.step === 2)!.reason).toBe('step_query_empty');
    expect(assembly.items.find(i => i.step === 3)!.reason).toBe('step_skipped_no_keys');
    expect(assembly.items.find(i => i.step === 4)!.reason).toBe('step_skipped_no_keys');
    expect(assembly.items).toHaveLength(4);
  });

  it('gives every step of every assembly a row', async () => {
    for (const byNs of [{}, ALL_WEAK, { 'team-1:memory': [hit({ rerank: STRONG })] }]) {
      const { assembly } = await runCluster(byNs);
      const steps = new Set(assembly.items.map(i => i.step));
      expect([...steps].sort()).toEqual([1, 2, 3, 4]);
    }
  });

  it('never records a query_hit for a step that returned nothing', async () => {
    const { assembly } = await runCluster({}, { signature: 'oom_killed', paths: [] });
    for (const item of assembly.items) {
      if (item.reason.endsWith('_query_hit')) expect(item.chunkId).toBeTruthy();
    }
  });

  it('clamps a pathological id or path instead of recording it whole', async () => {
    const { assembly } = await runCluster({
      'team-1:memory': [hit({ id: 'x'.repeat(5000), sourcePath: 'y'.repeat(5000), rerank: STRONG })],
    });
    const item = assembly.items.find(i => i.step === 1 && i.chunkId)!;
    expect(item.chunkId!.length).toBe(200);
    expect(item.sourcePath!.length).toBe(200);
  });
});

describe('logContextAssembly', () => {
  it('emits a bounded summary line and a separate detail line, joinable by id', async () => {
    const { assembly } = await runCluster({
      'team-1:memory': [hit({ rerank: STRONG }), hit({ rerank: STRONG }), hit({ rerank: STRONG })],
    });
    const lines = captureLogs(() => logContextAssembly(assembly));
    expect(lines).toHaveLength(2);

    const summaryLine = lines.find(l => l.startsWith(ASSEMBLY_LOG_PREFIX))!;
    const detailLine = lines.find(l => l.startsWith(ASSEMBLY_ITEMS_LOG_PREFIX))!;
    expect(summaryLine).toBeTruthy();
    expect(detailLine).toBeTruthy();

    const summary = JSON.parse(summaryLine.slice(ASSEMBLY_LOG_PREFIX.length));
    const detail = JSON.parse(detailLine.slice(ASSEMBLY_ITEMS_LOG_PREFIX.length));
    // The whole point of the split: the metric fields ride a line short enough
    // that truncation cannot reach them, and the join key is on both.
    expect(summary.assemblyId).toBe(detail.assemblyId);
    expect(summary.itemCount).toBe(detail.items.length);
    expect(summary.items).toBeUndefined();
    expect(summaryLine.length).toBeLessThan(1024);
  });

  it('keeps every field the day-one aggregation needs on the summary line', async () => {
    const { assembly } = await runCluster(ALL_WEAK);
    const lines = captureLogs(() => logContextAssembly(assembly));
    const summary = JSON.parse(lines[0]!.slice(ASSEMBLY_LOG_PREFIX.length));
    for (const field of ['recipe', 'at', 'fallbackFired', 'weakEscalationFired', 'workspaceId', 'itemCount', 'pathCount']) {
      expect(field in summary).toBe(true);
    }
  });

  it('emits only the summary when there are no items', () => {
    const empty = buildFanOutAssembly({
      trigger: { layer: 'exec' }, chain: {}, rendered: true,
    });
    empty.items = [];
    const lines = captureLogs(() => logContextAssembly(empty));
    expect(lines).toHaveLength(1);
  });

  it('never throws, and still emits the summary, on a record that cannot be serialized', () => {
    const circular: any = {
      assemblyId: 'a', at: 'now', recipe: 'r', source: 'live',
      trigger: {}, derivedKeys: {}, items: [], chain: {},
      weakEscalationFired: false, fallbackFired: false,
    };
    circular.items = [{ step: 1, reason: 'step_query_empty' }];
    circular.items[0].self = circular.items[0];
    const lines = captureLogs(() => {
      expect(() => logContextAssembly(circular)).not.toThrow();
    });
    // The summary drops `items`, so it survives an unserializable item.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(ASSEMBLY_LOG_PREFIX)).toBe(true);
  });
});

describe('buildFanOutAssembly — the denominator', () => {
  it('records the fan-out under its own recipe name', () => {
    const a = buildFanOutAssembly({
      workspaceId: 'ws-1', teamId: 'team-1',
      trigger: { layer: 'exec', subjectKind: null, signature: null },
      chain: CHAIN, rendered: true,
    });
    expect(a.recipe).toBe(DEFAULT_FAN_OUT_RECIPE);
    expect(a.chain).toEqual(CHAIN);
    expect(a.items[0]!.reason).toBe('fallback_semantic_search');
    expect(a.derivedKeys).toEqual({});
  });

  it('distinguishes a fan-out that rendered from one that returned nothing', () => {
    const base = { trigger: { layer: 'exec' as const }, chain: {} };
    expect(buildFanOutAssembly({ ...base, rendered: false }).items[0]!.reason).toBe('step_query_empty');
    expect(buildFanOutAssembly({ ...base, rendered: true }).items[0]!.reason).toBe('fallback_semantic_search');
  });
});

describe('buildClusteredKnowledgeContext — rendering, budget, and failure', () => {
  it('renders one labelled section per step that returned something', async () => {
    const { parts } = await runCluster({ 'team-1:memory': [hit({ content: '# oom gotcha' })] });
    const text = parts.join('\n');
    expect(text).toContain('tool-infra-error-v1');
    expect(text).toContain('Team memory for this error signature');
    expect(text).toContain('oom gotcha');
    expect(text).not.toContain('Past tasks on this error signature');
  });

  it('appends the uncertainty note', async () => {
    const { parts } = await runCluster({ 'team-1:memory': [hit({ content: '# oom gotcha' })] });
    expect(parts.join('\n')).toContain(TOOL_INFRA_ERROR_V1.uncertaintyNote);
  });

  it('keeps the corpora hint, which every claim used to get', async () => {
    const { store } = clusterStore({ 'team-1:memory': [hit({ content: '# oom gotcha' })] });
    const withCounts: KnowledgeQuerier = {
      query: store.query,
      countNamespace: async () => 7,
    };
    const { parts } = await buildClusteredKnowledgeContext({
      recipe: TOOL_INFRA_ERROR_V1, keys: DEFAULT_KEYS,
      workspaceId: 'ws-1', teamId: 'team-1',
      trigger: ERROR_TRIGGER, chain: CHAIN, store: withCounts,
    });
    // Dropping this silently removed the "query_knowledge before diagnosing"
    // instruction for exactly the population the recipe targets.
    expect(parts[0]).toContain('query_knowledge before diagnosing');
  });

  it('truncates at the section budget, and honours it', async () => {
    const many = Array.from({ length: 40 }, (_, i) => hit({ content: `# hit ${i} ${'x'.repeat(200)}` }));
    const tight: ClusterRecipe = { ...TOOL_INFRA_ERROR_V1, budgetChars: 600 };
    const { parts } = await runCluster({ 'team-1:memory': many }, undefined, undefined, tight);
    const body = parts.join('\n');
    expect(body).toContain('truncated at the 600-char section budget');
    // The budget is the accounted length of the rendered hits and headers, so
    // it has to actually bound them rather than being advisory.
    const accounted = parts.filter(l => !l.startsWith('\n## ') && !l.startsWith('\n_')).join('\n');
    expect(accounted.length).toBeLessThanOrEqual(600 + 80);
  });

  it('keeps a stale-baseline warning attached to its hit across truncation', async () => {
    const stale = hit({
      corpus: 'task',
      sourceType: 'task',
      content: `# shipped already ${'z'.repeat(120)}`,
      metadata: { success: true, prUrl: 'https://example.test/pr/1' },
      createdAt: new Date(Date.now() - 2 * 86400000),
    });
    const tight: ClusterRecipe = { ...TOOL_INFRA_ERROR_V1, budgetChars: 400 };
    const { parts } = await runCluster(
      { 'ws-1:task': [stale, stale, stale, stale] },
      undefined, undefined, tight,
    );
    const lines = parts.join('\n').split('\n');
    // Every rendered hit must still be followed by its warning. Showing the hit
    // without the reason not to trust it is worse than not showing it.
    lines.forEach((line, i) => {
      if (line.startsWith('- [')) expect(lines[i + 1]).toContain('MAY ALREADY BE SHIPPED');
    });
    expect(lines.some(l => l.includes('MAY ALREADY BE SHIPPED'))).toBe(true);
  });

  it('falls back rather than emitting a block with no retrieved content', async () => {
    // A budget too small for even one hit leaves only the truncation notice.
    // Treating that as a result would suppress the fan-out in exchange for
    // nothing.
    const tight: ClusterRecipe = { ...TOOL_INFRA_ERROR_V1, budgetChars: 1 };
    const { parts, assembly } = await runCluster(
      { 'team-1:memory': [hit({ content: '# a real hit' })] }, undefined, undefined, tight,
    );
    expect(parts).toEqual([]);
    expect(assembly.fallbackFired).toBe(true);
  });

  it('marks fallbackFired itself rather than relying on the caller', async () => {
    const { parts, assembly } = await runCluster({});
    expect(parts).toEqual([]);
    // The executor is what knows the body was empty. A second caller that
    // forgot to set this would otherwise log fallbackFired: false with no items.
    expect(assembly.fallbackFired).toBe(true);
  });

  it('returns no parts but a usable record when the store rejects', async () => {
    const store: KnowledgeQuerier = { async query() { throw new Error('store down'); } };
    const { parts, assembly } = await buildClusteredKnowledgeContext({
      recipe: TOOL_INFRA_ERROR_V1, keys: DEFAULT_KEYS,
      workspaceId: 'ws-1', teamId: 'team-1',
      trigger: ERROR_TRIGGER, chain: CHAIN, store,
    });
    expect(parts).toEqual([]);
    expect(assembly.fallbackFired).toBe(true);
    expect(assembly.assemblyId.length).toBeGreaterThan(0);
  });

  it('does not throw when the store itself is malformed', async () => {
    // Exercises the outer catch, which the per-step .catch() would otherwise
    // hide: this fails before any step runs.
    const broken = { query: undefined } as unknown as KnowledgeQuerier;
    const { parts, assembly } = await buildClusteredKnowledgeContext({
      recipe: TOOL_INFRA_ERROR_V1, keys: DEFAULT_KEYS,
      workspaceId: 'ws-1', teamId: 'team-1',
      trigger: ERROR_TRIGGER, chain: CHAIN, store: broken,
    });
    expect(parts).toEqual([]);
    expect(assembly.recipe).toBe('tool-infra-error-v1');
    expect(assembly.fallbackFired).toBe(true);
  });

  it('returns no parts when the workspace and team are both unknown', async () => {
    const { store } = clusterStore({});
    const { parts, assembly } = await buildClusteredKnowledgeContext({
      recipe: TOOL_INFRA_ERROR_V1, keys: { signature: 'oom_killed' },
      workspaceId: null, teamId: null,
      trigger: ERROR_TRIGGER, chain: CHAIN, store,
    });
    expect(parts).toEqual([]);
    expect(assembly.items.every(i => i.reason === 'step_skipped_no_keys')).toBe(true);
  });
});
