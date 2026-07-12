import { describe, it, expect } from 'bun:test';
import {
  buildKnowledgeContext,
  buildEntityCatalogContext,
  type KnowledgeQuerier,
  type EntityCatalogFetcher,
} from './knowledge-context';
import type { QueryResult } from '@buildd/core/knowledge-store';

function mockStore(byNs: Record<string, Array<Partial<QueryResult>>>): KnowledgeQuerier {
  return {
    async query(ns) {
      return (byNs[ns] ?? []).map((r, i) => ({
        id: r.id ?? `id-${i}`,
        namespace: ns,
        corpus: 'memory',
        sourceType: 'memory',
        sourcePath: null,
        sourceUrl: r.sourceUrl ?? null,
        content: r.content ?? '',
        metadata: {},
        score: 1,
      })) as QueryResult[];
    },
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
