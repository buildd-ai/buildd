// Model isolation (spec pluggable-knowledge-store L-7): the vector legs only
// compare against rows embedded by the query's own model. Other rows can still
// be found through the lexical leg.
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
mock.module('../db/index', () => ({
  db: { execute: async (q: unknown) => { executed.push(flatten(q)); return { rows: [] }; } },
}));

const { PgVectorStore } = await import('../knowledge-store/pg-vector-store');
const { embeddingConfigFromEnv } = await import('../knowledge-store/embedding-config');

// Declared at the store's size (1024, the `embedding` column): a size with no
// column gets no vector leg at all (knowledge-namespace-space.test.ts).
const embedder = (model: string) => ({ model, dimensions: 1024, embed: async (t: string[]) => t.map(() => [0.1, 0.2]) });
const vectorQueries = () => executed.filter(t => t.includes('<=>'));
const lexicalQueries = () => executed.filter(t => t.includes('websearch_to_tsquery') && !t.includes('<=>'));

beforeEach(() => { executed = []; });

describe('vector search is filtered to the query embedder model', () => {
  it('hybrid: the vector leg filters by model, the lexical leg does not', async () => {
    await new PgVectorStore(embedder('voyage-4-large') as any).query('ws-1:memory', { text: 'hello', mode: 'hybrid', useGraph: false });
    expect(vectorQueries()).toHaveLength(1);
    expect(vectorQueries()[0]).toContain('AND embedding_model = "voyage-4-large"');
    expect(lexicalQueries()).toHaveLength(1);
    expect(lexicalQueries()[0]).not.toContain('embedding_model');
  });

  it('vector mode filters by model', async () => {
    await new PgVectorStore(embedder('m-a') as any).query('ws-1:task', { text: 'hello', mode: 'vector', useGraph: false });
    expect(vectorQueries()[0]).toContain('AND embedding_model = "m-a"');
  });

  it('nearChunkId only takes a seed vector from the same model', async () => {
    await new PgVectorStore(embedder('m-a') as any).query('ws-1:task', { text: 'x', nearChunkId: 'c1', mode: 'vector', useGraph: false });
    expect(executed.find(t => t.includes('source_id = "c1"'))).toContain('embedding_model = "m-a"');
  });

  it('near-duplicate check filters by model', async () => {
    await new PgVectorStore(embedder('m-a') as any).nearDupeCheck('ws-1:memory', 'content');
    expect(vectorQueries()[0]).toContain('AND embedding_model = "m-a"');
  });

  it('an openai_compat config filters by the endpoint model, on write and query alike', async () => {
    const cfg = embeddingConfigFromEnv({ EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://e.test', EMBEDDING_MODEL: 'qwen3' });
    const store = new PgVectorStore(embedder('voyage-4-large') as any, null, { embeddingConfig: async () => cfg });
    // A caller-supplied vector, so no network call: the filter still names the endpoint model.
    await store.query('ws-1:memory', { text: 'hello', embedding: [0.1, 0.2], mode: 'hybrid', useGraph: false });
    expect(vectorQueries()[0]).toContain('AND embedding_model = "qwen3"');
    executed = [];
    await store.findReusableEmbeddings('ws-1:memory', [{ id: 'a', content: 'x', sourceType: 'memory' }]);
    expect(executed.find(t => t.includes('content_hash IN'))).toContain('embedding_model = "qwen3"');
  });

  it('a caller-supplied vector with no embedder configured is not filtered (model unknown)', async () => {
    await new PgVectorStore(null).query('ws-1:memory', { text: 'hello', embedding: [0.1, 0.2], mode: 'vector', useGraph: false });
    expect(vectorQueries()[0]).not.toContain('embedding_model');
  });
});

describe('switching a team to another model re-embeds on the next ingest', () => {
  const hashQuery = () => executed.find(t => t.includes('MIN(file_hash)')) ?? '';

  it("a team's pick: the unchanged-file skip only counts rows from the picked model", async () => {
    const cfg = { ...embeddingConfigFromEnv({ EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://e.test', EMBEDDING_MODEL: 'qwen3' }), source: 'team' as const };
    await new PgVectorStore(embedder('voyage-4-large') as any, null, { embeddingConfig: async () => cfg }).getFileHashes('ws-1:code', ['a.ts']);
    expect(hashQuery()).toContain('AND embedding_model = "qwen3"');
  });

  it('the default (no pick): the plain skip, so nothing re-embeds for a team that touched nothing', async () => {
    await new PgVectorStore(embedder('voyage-4-large') as any, null, { embeddingConfig: async () => embeddingConfigFromEnv({}) }).getFileHashes('ws-1:memory', ['a.ts']);
    expect(hashQuery()).not.toContain('embedding_model');
  });

  it('a pick with no usable key: the plain skip (nothing could embed anyway)', async () => {
    const cfg = { ...embeddingConfigFromEnv({}), provider: 'openai_compat' as const, source: 'team' as const, unavailable: 'no key' };
    const orig = console.warn;
    console.warn = () => {};
    try {
      await new PgVectorStore(embedder('voyage-4-large') as any, null, { embeddingConfig: async () => cfg }).getFileHashes('ws-1:memory', ['a.ts']);
    } finally {
      console.warn = orig;
    }
    expect(hashQuery()).not.toContain('embedding_model');
  });
});
