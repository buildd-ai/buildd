/**
 * The `evidence` corpus is reachable through query_knowledge and recall, and
 * returns nothing for a sensitive workspace
 * (docs/specs/byo-evidence-storage.md, "The `evidence` corpus").
 */
import { describe, it, expect } from 'bun:test';
import { handleRecallAction, handleMemoryAction, CORPORA, parseCorpora } from '../mcp-tools';
import { ALL_CORPORA } from '../knowledge-store/health';
import { CORPUS_AUTHORITY, HALF_LIFE_DAYS } from '../knowledge-store/recency-authority';
import type { KnowledgeStore, QueryResult } from '../knowledge-store/types';

const WS_ID = 'aaaa0000-0000-0000-0000-00000000e001';
const TEAM_ID = 'bbbb0000-0000-0000-0000-00000000e002';

function store(nsMap: Record<string, string[]>): KnowledgeStore & { queried: string[] } {
  const queried: string[] = [];
  return {
    queried,
    async query(ns): Promise<QueryResult[]> {
      queried.push(ns);
      return (nsMap[ns] ?? []).map((content, i) => ({
        id: `${ns}-${i}`,
        namespace: ns,
        corpus: ns.split(':')[1] as any,
        sourceType: 'evidence',
        sourcePath: null,
        sourceUrl: null,
        content,
        metadata: {},
        score: 0.9,
        isCurrent: true,
      }));
    },
    async upsert() { return { superseded: 0 }; },
    async delete() {},
    async listNamespaces() { return []; },
  };
}

const ctx = (ks: KnowledgeStore, extra: Record<string, unknown> = {}) => ({
  workspaceId: WS_ID,
  teamId: TEAM_ID,
  project: 'acme/widgets',
  knowledgeStore: ks,
  embedder: null,
  ...extra,
});

const mem = { get: async () => ({ memory: null }) } as any;
const text = (r: { content: Array<{ text: string }> }) => r.content.map(c => c.text).join('\n');

describe('evidence corpus registration', () => {
  it('is an advertised corpus for recall and query_knowledge', () => {
    expect(CORPORA as readonly string[]).toContain('evidence');
    expect(parseCorpora('evidence')).toBeNull();
    expect(parseCorpora(['evidence', 'task'])).toBeNull();
  });

  it('is counted by knowledge health', () => {
    expect(ALL_CORPORA).toContain('evidence');
  });

  it('has a ranking authority and a half-life', () => {
    expect(CORPUS_AUTHORITY.evidence).toBeGreaterThan(0);
    expect(HALF_LIFE_DAYS.evidence).toBeGreaterThan(0);
  });
});

describe('query_knowledge corpus=evidence', () => {
  it('searches {workspaceId}:evidence', async () => {
    const ks = store({ [`${WS_ID}:evidence`]: ['error: expect(received).toBe(expected) in ratchet'] });
    const res = await handleMemoryAction(mem, 'query_knowledge', { query: 'ratchet baseline', corpus: 'evidence' }, ctx(ks));
    expect(ks.queried).toEqual([`${WS_ID}:evidence`]);
    expect(text(res)).toContain('ratchet');
  });

  it('returns nothing for a sensitive workspace and never queries the store', async () => {
    const ks = store({ [`${WS_ID}:evidence`]: ['leaked failure text'] });
    const res = await handleMemoryAction(mem, 'query_knowledge', { query: 'failure', corpus: 'evidence' }, ctx(ks, { isSensitive: true }));
    expect(ks.queried).toEqual([]);
    expect(text(res)).not.toContain('leaked failure text');
  });

  it('withholds evidence from a sensitive multi-corpus query, keeps the rest', async () => {
    const ks = store({
      [`${WS_ID}:evidence`]: ['leaked failure text'],
      [`${WS_ID}:task`]: ['task outcome'],
    });
    const res = await handleMemoryAction(mem, 'query_knowledge', { query: 'failure', corpus: ['evidence', 'task'] }, ctx(ks, { isSensitive: true }));
    expect(ks.queried).not.toContain(`${WS_ID}:evidence`);
    expect(text(res)).toContain('task outcome');
    expect(text(res)).not.toContain('leaked failure text');
  });
});

describe('recall scope=evidence', () => {
  it('searches {workspaceId}:evidence', async () => {
    const ks = store({ [`${WS_ID}:evidence`]: ['sync > drains the queue timed out'] });
    const res = await handleRecallAction(mem, { query: 'drains the queue', scope: 'evidence' }, ctx(ks));
    expect(ks.queried).toContain(`${WS_ID}:evidence`);
    expect(text(res)).toContain('drains the queue');
  });

  it('returns nothing for a sensitive workspace, single and multi scope', async () => {
    const ks = store({ [`${WS_ID}:evidence`]: ['leaked failure text'], [`${WS_ID}:task`]: ['task outcome'] });
    const single = await handleRecallAction(mem, { query: 'failure', scope: 'evidence' }, ctx(ks, { isSensitive: true }));
    const multi = await handleRecallAction(mem, { query: 'failure', scope: ['evidence', 'task'] }, ctx(ks, { isSensitive: true }));
    expect(ks.queried).not.toContain(`${WS_ID}:evidence`);
    expect(text(single)).not.toContain('leaked failure text');
    expect(text(multi)).not.toContain('leaked failure text');
    expect(text(multi)).toContain('task outcome');
  });
});
