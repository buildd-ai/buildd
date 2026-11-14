// Per-namespace embedding space (docs/specs/local-runner-provider.md §5.3):
// the row is created on first touch, moved when the pick changes, and every
// vector leg of PgVectorStore selects the column it names. A size the
// namespace is not stored at never runs against the index (D-2); a size with
// no column never stores a vector (D-4). The Voyage default's SQL is unchanged
// (AC-18).
import { beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[], sep?: unknown) => ({ _sql: true, parts, sep }) },
  ),
}));

function flatten(q: any): string {
  if (q === null || q === undefined || typeof q !== 'object') return JSON.stringify(q) ?? '';
  if (Array.isArray(q.parts)) return q.parts.map(flatten).join(q.sep ? flatten(q.sep) : ', ');
  let out = '';
  (Array.from(q.strings ?? []) as string[]).forEach((s, i) => {
    out += s;
    if (i < (q.values ?? []).length) out += flatten(q.values[i]);
  });
  return out;
}

let executed: string[] = [];
/** Answers by statement tag; a stored row is returned for namespace reads when `stored` is set. */
let stored: Record<string, unknown> | null = null;
let answer: (text: string) => unknown[] | null = () => null;
mock.module('../db/index', () => ({
  db: {
    execute: async (q: unknown) => {
      const text = flatten(q);
      executed.push(text);
      const scripted = answer(text);
      if (scripted) return { rows: scripted };
      if (text.includes('knowledge:namespace_read')) return { rows: stored ? [stored] : [] };
      return { rows: [] };
    },
  },
}));

const { PgVectorStore } = await import('../knowledge-store/pg-vector-store');
const { resolveNamespaceSpace, resetNamespaceSpaceCache } = await import('../knowledge-store/namespace-space');
const { embeddingConfigFromEnv } = await import('../knowledge-store/embedding-config');

const embedder = (model: string, dimensions: number) => ({ model, dimensions, embed: async (t: string[]) => t.map(() => Array.from({ length: dimensions }, () => 0.1)) });
const row = (model: string, dimensions: number, extra: Record<string, unknown> = {}) => ({
  namespace: 'ws-1:memory', embedding_provider: null, embedding_model: model, dimensions,
  vector_column: dimensions === 768 ? 'embedding_768' : dimensions === 1536 ? 'embedding_1536' : 'embedding',
  reembed_status: 'none', reembed_total: 0, reembed_done: 0, ...extra,
});
const tagged = (tag: string) => executed.filter(t => t.includes(tag));
const vectorQueries = () => executed.filter(t => t.includes('<=>'));

beforeEach(() => {
  executed = [];
  stored = null;
  answer = () => null;
  resetNamespaceSpaceCache();
});

describe('resolveNamespaceSpace', () => {
  const exec = async (q: unknown) => {
    const text = flatten(q);
    executed.push(text);
    const scripted = answer(text);
    if (scripted) return { rows: scripted };
    if (text.includes('knowledge:namespace_read')) return { rows: stored ? [stored] : [] };
    return { rows: [] };
  };

  it('creates the row from the first embedder that touches the namespace (D-1, D-5)', async () => {
    answer = text => (text.includes('knowledge:namespace_create') ? [row('voyage-4-large', 1024)] : null);
    const res = await resolveNamespaceSpace('ws-1:memory', { model: 'voyage-4-large', dimensions: 1024, provider: 'voyage' }, exec);
    expect(res).toMatchObject({ kind: 'ok', created: true, moved: false, space: { model: 'voyage-4-large', dimensions: 1024, vectorColumn: 'embedding' } });
    const create = tagged('knowledge:namespace_create')[0]!;
    expect(create).toContain('ON CONFLICT (namespace) DO NOTHING');
    expect(create).toContain('"voyage-4-large", 1024::int, "embedding"');
    expect(tagged('knowledge:namespace_move')).toHaveLength(0);
  });

  it('a matching row is read, not written, and then served from cache', async () => {
    stored = row('m1', 768);
    const first = await resolveNamespaceSpace('ws-1:memory', { model: 'm1', dimensions: 768 }, exec);
    expect(first).toMatchObject({ kind: 'ok', created: false, moved: false, space: { vectorColumn: 'embedding_768' } });
    expect(executed).toHaveLength(1);
    await resolveNamespaceSpace('ws-1:memory', { model: 'm1', dimensions: 768 }, exec);
    expect(executed).toHaveLength(1);
  });

  it('a changed pick moves the row to the new space and marks a re-embed pending (D-3, AC-16)', async () => {
    stored = row('m1', 1024);
    answer = text => (text.includes('knowledge:namespace_move') ? [row('m2', 768, { reembed_status: 'pending', reembed_total: 40 })] : null);
    const res = await resolveNamespaceSpace('ws-1:memory', { model: 'm2', dimensions: 768 }, exec);
    expect(res).toMatchObject({ kind: 'ok', moved: true, space: { model: 'm2', dimensions: 768, vectorColumn: 'embedding_768', reembedStatus: 'pending', reembedTotal: 40 } });
    const move = tagged('knowledge:namespace_move')[0]!;
    expect(move).toContain("reembed_status = 'pending'");
    expect(move).toContain('WHERE namespace = "ws-1:memory" AND (embedding_model <> "m2" OR dimensions <> 768::int)');
  });

  it('a concurrent move that wins leaves this embedder mismatched: no vector leg', async () => {
    stored = row('m1', 1024);
    const res = await resolveNamespaceSpace('ws-1:memory', { model: 'm2', dimensions: 768 }, exec);
    expect(res).toMatchObject({ kind: 'mismatch', space: { model: 'm1', dimensions: 1024 } });
  });

  it('a size with no column is unsupported, never truncated', async () => {
    const res = await resolveNamespaceSpace('ws-1:memory', { model: 'all-minilm', dimensions: 384 }, exec);
    expect(res).toMatchObject({ kind: 'unsupported', dimensions: 384 });
    expect(tagged('knowledge:namespace_create')).toHaveLength(0);
  });
});

describe('PgVectorStore selects the namespace column', () => {
  it('Voyage default at 1024: the vector SQL is unchanged and a row is created at 1024 (AC-18)', async () => {
    await new PgVectorStore(embedder('voyage-4-large', 1024) as any).query('ws-1:memory', { text: 'hello', mode: 'hybrid', useGraph: false });
    expect(vectorQueries()).toHaveLength(1);
    expect(vectorQueries()[0]).toContain('1 - (embedding <=> ');
    expect(vectorQueries()[0]).toContain('AND embedding IS NOT NULL');
    expect(vectorQueries()[0]).toContain('AND embedding_model = "voyage-4-large"');
    expect(vectorQueries()[0]).not.toContain('embedding_768');
    expect(tagged('knowledge:namespace_create')[0]).toContain('1024::int, "embedding"');
  });

  it('a 768 embedder searches and stores in embedding_768 with the model filter, clearing the other columns', async () => {
    const store = new PgVectorStore(embedder('nomic-embed-text', 768) as any);
    await store.query('ws-1:memory', { text: 'hello', mode: 'vector', useGraph: false });
    expect(vectorQueries()[0]).toContain('1 - (embedding_768 <=> ');
    expect(vectorQueries()[0]).toContain('AND embedding_768 IS NOT NULL');
    expect(vectorQueries()[0]).toContain('AND embedding_model = "nomic-embed-text"');
    executed = [];
    await store.upsert('ws-1:memory', [{ id: 'a', content: 'x', sourceType: 'memory', fileHash: 'h' }]);
    const insert = executed.find(t => t.includes('INSERT INTO knowledge_chunks'))!;
    expect(insert).toContain('content, lexical_text, embedding_768, embedding_model');
    expect(insert).toContain('embedding_768       = EXCLUDED.embedding_768');
    expect(insert).toContain('embedding = NULL, embedding_1536 = NULL');
    expect(insert).toContain('"nomic-embed-text"');
    const reuse = executed.find(t => t.includes('content_hash IN'))!;
    expect(reuse).toContain('embedding_768::text AS embedding');
    expect(reuse).toContain('AND embedding_768 IS NOT NULL');
  });

  it('a query embedder of another size than the namespace is not run against the index: lexical-only (D-2)', async () => {
    stored = row('m1', 1024);
    const store = new PgVectorStore(embedder('m2', 768) as any);
    await store.query('ws-1:memory', { text: 'hello', mode: 'hybrid', useGraph: false });
    expect(vectorQueries()).toHaveLength(0);
    expect(executed.some(t => t.includes('websearch_to_tsquery'))).toBe(true);
    expect(await store.query('ws-1:memory', { text: 'hello', mode: 'vector', useGraph: false })).toEqual([]);
  });

  it('a mismatched write stores lexical-only rows without a file hash so the next ingest retries (AC-14)', async () => {
    stored = row('m1', 1024);
    const store = new PgVectorStore(embedder('m2', 768) as any);
    const out = await store.upsert('ws-1:memory', [{ id: 'a', content: 'x', sourceType: 'memory', fileHash: 'h' }]);
    expect(out.lexicalOnly).toBe(1);
    const insert = executed.find(t => t.includes('INSERT INTO knowledge_chunks'))!;
    expect(insert).not.toContain('::vector');
    expect(insert).not.toContain('"h"'); // file hash withheld
    expect(executed.some(t => t.includes('<=>'))).toBe(false);
  });

  it('an unsupported size never stores a vector either', async () => {
    const store = new PgVectorStore(embedder('all-minilm', 384) as any);
    const out = await store.upsert('ws-1:memory', [{ id: 'a', content: 'x', sourceType: 'memory', fileHash: 'h' }]);
    expect(out.lexicalOnly).toBe(1);
    expect(tagged('knowledge:namespace_create')).toHaveLength(0);
  });

  it('a caller-supplied vector with no embedder searches the column its size names', async () => {
    await new PgVectorStore(null).query('ws-1:memory', { text: 'hello', embedding: Array(1536).fill(0.1), mode: 'vector', useGraph: false });
    expect(vectorQueries()[0]).toContain('embedding_1536 <=> ');
    expect(vectorQueries()[0]).not.toContain('embedding_model');
  });

  it('near-chunk seeds and near-dupe checks read the namespace column', async () => {
    const store = new PgVectorStore(embedder('m', 1536) as any);
    await store.query('ws-1:task', { text: 'x', nearChunkId: 'c1', mode: 'vector', useGraph: false });
    const seed = executed.find(t => t.includes('source_id = "c1"'))!;
    expect(seed).toContain('SELECT embedding_1536::text AS embedding');
    expect(seed).toContain('AND embedding_1536 IS NOT NULL');
    executed = [];
    await store.nearDupeCheck('ws-1:memory', 'content');
    expect(vectorQueries()[0]).toContain('embedding_1536 <=> ');
    expect(vectorQueries()[0]).toContain('AND embedding_model = "m"');
  });

  it('a team pick on an OpenAI-compatible endpoint records the namespace under the endpoint model', async () => {
    const cfg = embeddingConfigFromEnv({ EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://e.test', EMBEDDING_MODEL: 'qwen3' });
    const store = new PgVectorStore(embedder('voyage-4-large', 1024) as any, null, { embeddingConfig: async () => cfg });
    await store.query('ws-1:memory', { text: 'hello', embedding: Array(1024).fill(0.1), mode: 'hybrid', useGraph: false });
    expect(tagged('knowledge:namespace_create')[0]).toContain('"qwen3", 1024::int, "embedding"');
    expect(vectorQueries()[0]).toContain('AND embedding_model = "qwen3"');
  });
});

describe('PgVectorStore.reembedNamespace (D-3, D-6)', () => {
  it('writes the next batch into the namespace column, clears the others, and marks progress', async () => {
    stored = row('m2', 768, { reembed_status: 'pending', reembed_total: 2 });
    let batches = 0;
    answer = text => {
      if (text.includes('ORDER BY id')) return batches++ === 0 ? [{ id: 'id-1', text: 'one' }, { id: 'id-2', text: 'two' }] : [];
      if (text.includes('SELECT count(*) AS cnt FROM knowledge_chunks WHERE namespace')) return [{ cnt: 0 }];
      return null;
    };
    const store = new PgVectorStore(embedder('m2', 768) as any);
    const out = await store.reembedNamespace('ws-1:memory', { batchSize: 10 });
    expect(out).toEqual({ status: 'done', processed: 2, remaining: 0 });
    const updates = executed.filter(t => t.includes('UPDATE knowledge_chunks'));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain('SET embedding_768 = "[');
    expect(updates[0]).toContain('embedding = NULL, embedding_1536 = NULL, embedding_model = "m2"');
    expect(updates[0]).toContain('WHERE id = "id-1"::uuid');
    const select = executed.find(t => t.includes('ORDER BY id'))!;
    expect(select).toContain('(embedding_model IS DISTINCT FROM "m2" OR embedding_768 IS NULL)');
    expect(select).toContain('LIMIT 10');
    expect(tagged('knowledge:namespace_reembed_running')).toHaveLength(2);
    expect(tagged('knowledge:namespace_reembed_end')[0]).toContain('reembed_status = "done"');
  });

  it('a namespace with nothing left is marked done; a guard refusal leaves the rows for the next tick', async () => {
    stored = row('m2', 768, { reembed_status: 'pending' });
    const store = new PgVectorStore(embedder('m2', 768) as any);
    expect(await store.reembedNamespace('ws-1:memory')).toEqual({ status: 'done', processed: 0, remaining: 0 });
    executed = [];
    answer = text => (text.includes('ORDER BY id') ? [{ id: 'id-1', text: 'one' }] : null);
    const denied = new PgVectorStore({ model: 'm2', dimensions: 768, embed: async () => null } as any);
    expect(await denied.reembedNamespace('ws-1:memory')).toEqual({ status: 'denied', processed: 0, remaining: 1 });
    expect(executed.some(t => t.includes('UPDATE knowledge_chunks'))).toBe(false);
  });
});
