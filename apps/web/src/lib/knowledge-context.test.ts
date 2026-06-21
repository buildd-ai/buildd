import { describe, it, expect } from 'bun:test';
import { buildKnowledgeContext, type KnowledgeQuerier } from './knowledge-context';
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
