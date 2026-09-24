/**
 * query_knowledge shares recall's corpus vocabulary and per-corpus failure
 * tracking (see mcp-tools-recall-learn.test.ts's equivalent suite) — both
 * cast an unvalidated `corpus` param and swallowed per-namespace query
 * failures with `.catch(() => [])`, so a typo'd corpus or a genuine
 * retrieval outage both silently read back as "no knowledge found".
 */
import { describe, it, expect } from 'bun:test';
import { handleMemoryAction } from '../mcp-tools';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

const WS_ID = 'aaaa0000-0000-0000-0000-000000000000';
const TEAM_ID = 'bbbb0000-0000-0000-0000-000000000000';

function makeStore(
  nsMap: Record<string, Partial<QueryResult>[] | Error>,
): KnowledgeStore {
  return {
    async query(ns): Promise<QueryResult[]> {
      const entry = nsMap[ns];
      if (entry instanceof Error) throw entry;
      const chunks = entry ?? [];
      const corpus = ns.split(':').slice(1).join(':') as any;
      return chunks.map((c, i) => ({
        id: c.id ?? `chunk-${ns}-${i}`,
        namespace: ns,
        corpus,
        sourceType: c.sourceType ?? corpus,
        sourcePath: null,
        sourceUrl: c.sourceUrl ?? null,
        content: c.content ?? `content ${ns} ${i}`,
        metadata: c.metadata ?? {},
        score: c.score ?? 0.8,
        createdAt: (c as any).createdAt ?? null,
        isCurrent: (c as any).isCurrent ?? true,
      }));
    },
    async upsert() {},
    async delete() {},
    async listNamespaces() { return []; },
  };
}

function ctx(store: KnowledgeStore) {
  return { workspaceId: WS_ID, teamId: TEAM_ID, knowledgeStore: store, embedder: null as any };
}

const nullMemClient = {} as any;

describe('query_knowledge — corpus validation', () => {
  it('rejects an unknown corpus in the array form', async () => {
    const store = makeStore({});
    await expect(
      handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'x', corpus: ['tasks'] }, ctx(store)),
    ).rejects.toThrow(/Unknown scope/i);
  });

  it('rejects an unknown corpus in the single-string form', async () => {
    const store = makeStore({});
    await expect(
      handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'x', corpus: 'notarealcorpus' }, ctx(store)),
    ).rejects.toThrow(/Unknown scope/i);
  });
});

describe('query_knowledge — per-corpus failure tracking (multi-corpus)', () => {
  it('a failing corpus does not hide a hit from a working corpus, and the failure is reported', async () => {
    const store = makeStore({
      [`${TEAM_ID}:memory`]: new Error('timeout'),
      [`${WS_ID}:task`]: [{ content: 'task hit', isCurrent: true } as any],
    });
    const res = await handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'x', corpus: ['memory', 'task'] }, ctx(store));
    expect(res.isError).toBeFalsy();
    const out = res.content[0].text;
    expect(out).toContain('task hit');
    expect(out).toContain('memory');
    expect(out).toContain('timeout');
    expect(out).toContain('failed');
  });

  it('throws when every queried corpus fails', async () => {
    const store = makeStore({
      [`${TEAM_ID}:memory`]: new Error('timeout'),
      [`${WS_ID}:task`]: new Error('connection refused'),
    });
    await expect(
      handleMemoryAction(nullMemClient, 'query_knowledge', { query: 'x', corpus: ['memory', 'task'] }, ctx(store)),
    ).rejects.toThrow(/All corpora failed/);
  });
});
