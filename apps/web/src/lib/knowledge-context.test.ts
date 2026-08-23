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
      'ws-1:spec': 340,
    });
    const lines = await buildKnowledgeContext('fix auth bug', 'ws-1', 'team-1', store);
    const text = lines.join('\n');
    expect(text).toContain('knowledge:');
    expect(text).toContain('memory 208');
    expect(text).toContain('code indexed');
    expect(text).toContain('spec 340');
    expect(text).toContain('query_knowledge');
  });

  it('shows code not indexed when no code chunks', async () => {
    const store = mockStore({}, {
      'team-1:memory': 50,
      'ws-1:code': 0,
      'ws-1:spec': 0,
    });
    const text = (await buildKnowledgeContext('task', 'ws-1', 'team-1', store)).join('\n');
    expect(text).toContain('code not indexed');
    expect(text).toContain('spec not indexed');
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
