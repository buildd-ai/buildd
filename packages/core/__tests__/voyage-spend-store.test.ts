// What PgVectorStore does around the guard: lexical fallback when Voyage is
// refused, and not paying twice for text it already holds a vector for.
import { beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));

function flatten(q: any): string {
  if (q === null || q === undefined || typeof q !== 'object') return JSON.stringify(q) ?? '';
  if (Array.isArray(q.parts)) return q.parts.map(flatten).join(', ');
  let out = '';
  (Array.from(q.strings ?? []) as string[]).forEach((s, i) => {
    out += s;
    if (i < (q.values ?? []).length) out += flatten(q.values[i]);
  });
  return out;
}

let executed: string[] = [];
let respond: (text: string) => Array<Record<string, unknown>> = () => [];

mock.module('../db/index', () => ({
  db: {
    execute: async (q: unknown) => {
      const text = flatten(q);
      executed.push(text);
      return { rows: respond(text) };
    },
  },
}));

const { PgVectorStore, RERANK_CANDIDATE_CAP } = await import('../knowledge-store/pg-vector-store');
const { ingestFiles } = await import('../knowledge-store/ingest');
const { clearsScoreFloor } = await import('../knowledge-store/reranker');

function embedder(result: 'ok' | 'denied' = 'ok') {
  const calls: Array<{ texts: string[]; inputType: string; call: { namespace: string; caller: string } }> = [];
  return {
    calls,
    model: 'voyage-4-large',
    dimensions: 1024, // the store's own size; a size with no column gets no vector leg
    async embed(texts: string[], inputType: string, call: { namespace: string; caller: string }) {
      calls.push({ texts, inputType, call });
      return result === 'denied' ? null : texts.map(() => [0.1, 0.2]);
    },
  };
}

const chunk = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, content, sourceType: 'memory', ...extra });
const inserts = () => executed.filter(t => t.includes('INSERT INTO knowledge_chunks'));

beforeEach(() => {
  executed = [];
  respond = () => [];
});

describe('upsert when the guard refuses', () => {
  it('stores the chunk with no vector and no file hash, and counts it', async () => {
    const e = embedder('denied');
    const res = await new PgVectorStore(e as any).upsert('ws:memory', [chunk('a', 'text', { fileHash: 'abc' })]);
    expect(res.lexicalOnly).toBe(1);
    const [insert] = inserts();
    expect(insert).not.toContain('::vector');
    expect(insert).not.toContain('"abc"');
  });

  it('clears a stale vector only when the text changed', async () => {
    await new PgVectorStore(embedder('denied') as any).upsert('ws:memory', [chunk('a', 'new text')]);
    expect(inserts()[0]).toContain('embedding = CASE WHEN knowledge_chunks.content_hash = EXCLUDED.content_hash');
  });

  it('keeps the file hash when there is simply no embedder', async () => {
    const res = await new PgVectorStore(null).upsert('ws:memory', [chunk('a', 'text', { fileHash: 'abc' })]);
    expect(res.lexicalOnly).toBeUndefined();
    expect(inserts()[0]).toContain('"abc"');
  });
});

describe('upsert attribution', () => {
  it('names the namespace and the store caller', async () => {
    const e = embedder();
    await new PgVectorStore(e as any, null, { caller: 'ingest_diff' }).upsert('ws:memory', [chunk('a', 'text')]);
    expect(e.calls[0].call).toEqual({ namespace: 'ws:memory', caller: 'ingest_diff' });
    expect(e.calls[0].inputType).toBe('document');
  });
});

describe('vector reuse', () => {
  it('does not embed text the namespace already holds a vector for', async () => {
    respond = t => (t.includes('embedding::text') ? [{ text: 'same', embedding: '[1,2]' }] : []);
    const e = embedder();
    await new PgVectorStore(e as any).upsert('ws:memory', [chunk('a', 'same'), chunk('b', 'changed')]);
    expect(e.calls.length).toBe(1);
    expect(e.calls[0].texts).toEqual(['changed']);
    expect(inserts()[0]).toContain('[1,2]');
  });

  it('makes no embed call at all when nothing changed', async () => {
    respond = t => (t.includes('embedding::text') ? [{ text: 'same', embedding: '[1,2]' }] : []);
    const e = embedder();
    await new PgVectorStore(e as any).upsert('ws:memory', [chunk('a', 'same')]);
    expect(e.calls).toEqual([]);
  });

  it('only reuses a vector from the same model', async () => {
    await new PgVectorStore(embedder() as any).findReusableEmbeddings('ws:memory', [chunk('a', 'x')]);
    expect(executed.find(t => t.includes('content_hash IN'))).toContain('embedding_model = "voyage-4-large"');
  });

  it('embeds identical text in one batch once', async () => {
    const e = embedder();
    await new PgVectorStore(e as any).upsert('ws:memory', [chunk('a', 'dup'), chunk('b', 'dup')]);
    expect(e.calls[0].texts).toEqual(['dup']);
    expect(inserts().length).toBe(2);
  });

  it('ingestFiles reads stored vectors before it clears the file', async () => {
    const order: string[] = [];
    const store = {
      findReusableEmbeddings: async () => { order.push('find'); return new Map([['t', '[1]']]); },
      deleteBySource: async () => { order.push('delete'); },
      upsert: async (_ns: string, _c: unknown[], opts: { reuse?: Map<string, string> }) => {
        order.push(`upsert:${opts?.reuse?.size}`);
        return { superseded: 0, lexicalOnly: 2 };
      },
    };
    const res = await ingestFiles(store as any, 'ws', 'docs', [{ path: 'a.md', content: 'hello' }]);
    expect(order).toEqual(['find', 'delete', 'upsert:1']);
    expect(res.chunksLexicalOnly).toBe(2);
  });
});

describe('contentDedup', () => {
  it('drops the chunk before embedding, not after', async () => {
    respond = t => (t.includes('source_id !=') ? [{ source_id: 'other' }] : []);
    const e = embedder();
    await new PgVectorStore(e as any).upsert('ws:pr', [chunk('a', 'diff', { contentDedup: true })]);
    expect(e.calls).toEqual([]);
    expect(inserts()).toEqual([]);
  });
});

describe('query when the guard refuses', () => {
  const row = (id: string) => ({
    source_id: id, namespace: 'ws:memory', corpus: 'memory', source_type: 'memory', source_path: null,
    source_url: null, content: id, metadata: {}, is_current: true,
  });
  const lexicalRows = (ids: string[]) => (t: string) => {
    if (t.includes('ts_rank')) return ids.map((id, i) => ({ id, score: 1 - i / 10 }));
    if (t.includes('source_id IN') || t.includes('source_id = ANY')) return ids.map(row);
    return [];
  };

  it('runs lexical-only and marks the hits', async () => {
    respond = lexicalRows(['a', 'b']);
    const e = embedder('denied');
    const out = await new PgVectorStore(e as any).query('ws:memory', { text: 'q', useGraph: false, trackHits: false, recencyAuthority: false });
    expect(out.map(r => r.id)).toEqual(['a', 'b']);
    expect(out.every(r => r.scoreBreakdown?.budgetFallback)).toBe(true);
  });

  it('keeps fused order and marks the hits when only rerank is refused', async () => {
    respond = lexicalRows(['a', 'b']);
    const reranker = { model: 'r', rerank: async () => null };
    const out = await new PgVectorStore(null, reranker as any).query('ws:memory', { text: 'q', mode: 'lexical', useGraph: false, trackHits: false, recencyAuthority: false });
    expect(out.map(r => r.id)).toEqual(['a', 'b']);
    expect(out[0].scoreBreakdown?.budgetFallback).toBe(true);
  });

  it('a successful rerank clears the mark, even after a refused embed', async () => {
    respond = lexicalRows(['a', 'b']);
    const reranker = { model: 'r', rerank: async () => [{ index: 1, score: 0.9 }, { index: 0, score: 0.8 }] };
    const out = await new PgVectorStore(embedder('denied') as any, reranker as any).query('ws:memory', { text: 'q', useGraph: false, trackHits: false, recencyAuthority: false });
    expect(out.map(r => r.id)).toEqual(['b', 'a']);
    expect(out[0].scoreBreakdown?.budgetFallback).toBeUndefined();
  });
});

describe('rerank width', () => {
  it('sends no more than the cap, whatever topK asks for', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `c${i}`);
    respond = t => {
      if (t.includes('ts_rank')) return ids.map((id, i) => ({ id, score: 1 - i / 100 }));
      if (t.includes('source_id IN') || t.includes('source_id = ANY')) return ids.map(id => ({ source_id: id, namespace: 'ws:memory', corpus: 'memory', source_type: 'memory', content: id, metadata: {} }));
      return [];
    };
    let sent = 0;
    const reranker = { model: 'r', rerank: async (_q: string, docs: string[]) => { sent = docs.length; return docs.map((_, index) => ({ index, score: 1 })); } };
    await new PgVectorStore(null, reranker as any).query('ws:memory', { text: 'q', mode: 'lexical', topK: 15, useGraph: false, trackHits: false, recencyAuthority: false });
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(RERANK_CANDIDATE_CAP);
  });

  it('passes the query caller through to the reranker', async () => {
    respond = t => {
      if (t.includes('ts_rank')) return [{ id: 'a', score: 1 }, { id: 'b', score: 0.5 }];
      if (t.includes('source_id IN') || t.includes('source_id = ANY')) return ['a', 'b'].map(id => ({ source_id: id, namespace: 'ws:memory', corpus: 'memory', source_type: 'memory', content: id, metadata: {} }));
      return [];
    };
    let seen: unknown;
    const reranker = { model: 'r', rerank: async (_q: string, docs: string[], _k: number, call: unknown) => { seen = call; return docs.map((_, index) => ({ index, score: 1 })); } };
    await new PgVectorStore(null, reranker as any, { caller: 'store' }).query('ws:memory', { text: 'q', mode: 'lexical', caller: 'recall', useGraph: false, trackHits: false, recencyAuthority: false });
    expect(seen).toEqual({ namespace: 'ws:memory', caller: 'recall' });
  });
});

describe('clearsScoreFloor', () => {
  it('holds a reranked hit to the floor', () => {
    expect(clearsScoreFloor({ score: 0.2 } as any, 0.45)).toBe(false);
    expect(clearsScoreFloor({ score: 0.5 } as any, 0.45)).toBe(true);
  });

  it('lets a budget-fallback hit through', () => {
    expect(clearsScoreFloor({ score: 0.01, scoreBreakdown: { budgetFallback: true } } as any, 0.45)).toBe(true);
  });
});
