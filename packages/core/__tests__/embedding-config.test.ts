// Which embedder a namespace gets, from env and from an `embedding_endpoint`
// secret. Spec: docs/specs/pluggable-knowledge-store.md.
import { afterEach, describe, expect, it } from 'bun:test';
import {
  embeddingConfigFromEnv,
  getEmbedderForCorpus,
  parseEmbeddingEndpoint,
  resolveEmbeddingConfig,
} from '../knowledge-store/embedding-config';
import { OpenAICompatibleEmbedder } from '../knowledge-store/openai-compatible-embedder';
import { VoyageEmbedder } from '../knowledge-store/voyage-embedder';

const WS = '00000000-0000-4000-8000-000000000001';
const fallback = { model: 'fallback-model', dimensions: 1024, embed: async () => [] };
const savedKey = process.env.VOYAGE_API_KEY;

afterEach(() => {
  if (savedKey === undefined) delete process.env.VOYAGE_API_KEY;
  else process.env.VOYAGE_API_KEY = savedKey;
});

describe('provider unset: Voyage exactly as before', () => {
  it('env with no EMBEDDING_PROVIDER is Voyage', () => {
    expect(embeddingConfigFromEnv({}).provider).toBe('voyage');
    expect(embeddingConfigFromEnv({ EMBEDDING_PROVIDER: 'voyage', EMBEDDING_BASE_URL: 'https://x' }).provider).toBe('voyage');
  });

  it('code/docs/spec get voyage-code-3 when a key is set; other corpora the store embedder', () => {
    process.env.VOYAGE_API_KEY = 'k';
    const cfg = embeddingConfigFromEnv({});
    for (const corpus of ['code', 'docs', 'spec'] as const) {
      const e = getEmbedderForCorpus(corpus, cfg, fallback);
      expect(e).toBeInstanceOf(VoyageEmbedder);
      expect(e!.model).toBe('voyage-code-3');
    }
    for (const corpus of ['memory', 'task', 'pr', 'artifact'] as const) {
      expect(getEmbedderForCorpus(corpus, cfg, fallback)).toBe(fallback);
    }
  });

  it('a non-code corpus with no store embedder stays lexical-only', () => {
    // (voyage-code-3 is a process singleton once built, as it always was.)
    const cfg = embeddingConfigFromEnv({});
    expect(getEmbedderForCorpus('memory', cfg, null)).toBeNull();
  });

  it('a non-UUID owner costs no lookup', async () => {
    let looked = false;
    const cfg = await resolveEmbeddingConfig('ws-1', { env: {}, loadSecret: async () => { looked = true; return null; } });
    expect(looked).toBe(false);
    expect(cfg.provider).toBe('voyage');
  });
});

describe('openai_compat from env', () => {
  const env = {
    EMBEDDING_PROVIDER: 'openai_compat',
    EMBEDDING_BASE_URL: 'https://openrouter.ai/api/v1',
    EMBEDDING_MODEL: 'qwen/qwen3-embedding-8b',
    EMBEDDING_API_KEY: 'sk-or',
    EMBEDDING_QUERY_PREFIX: 'Instruct: x\nQuery: ',
    EMBEDDING_MATRYOSHKA: 'true',
    EMBEDDING_PRICE_PER_1M_TOKENS: '0.01',
  };

  it('reads every field', () => {
    expect(embeddingConfigFromEnv(env)).toMatchObject({
      provider: 'openai_compat', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-embedding-8b', apiKey: 'sk-or',
      queryPrefix: 'Instruct: x\nQuery: ', docPrefix: '', matryoshka: true, pricePerMTokens: 0.01, unmetered: false,
    });
    expect(embeddingConfigFromEnv({ ...env, EMBEDDING_PRICE_PER_1M_TOKENS: 'unmetered' })).toMatchObject({ unmetered: true, pricePerMTokens: null });
  });

  it('one endpoint embedder for every corpus, write and query alike, ignoring the store embedder', () => {
    process.env.VOYAGE_API_KEY = 'k';
    const cfg = embeddingConfigFromEnv(env);
    const code = getEmbedderForCorpus('code', cfg, fallback);
    const memory = getEmbedderForCorpus('memory', cfg, fallback);
    expect(code).toBeInstanceOf(OpenAICompatibleEmbedder);
    expect(code).toBe(memory);
    expect(code!.model).toBe('qwen/qwen3-embedding-8b');
  });

  it('missing a base URL or a model is lexical-only, not Voyage', () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      expect(getEmbedderForCorpus('memory', embeddingConfigFromEnv({ ...env, EMBEDDING_MODEL: '' }), fallback)).toBeNull();
    } finally {
      console.warn = orig;
    }
  });
});

describe('embedding_endpoint secret', () => {
  it('validates the blob', () => {
    expect(parseEmbeddingEndpoint('nope').ok).toBe(false);
    expect(parseEmbeddingEndpoint('{"model":"m"}').ok).toBe(false);
    expect(parseEmbeddingEndpoint('{"baseUrl":"ftp://x","model":"m"}').ok).toBe(false);
    expect(parseEmbeddingEndpoint('{"baseUrl":"https://x","model":"m","provider":"other"}').ok).toBe(false);
    const ok = parseEmbeddingEndpoint('{"baseUrl":"https://x.test/v1","model":"m","price":"unmetered","matryoshka":true}');
    expect(ok).toMatchObject({ ok: true, value: { provider: 'openai_compat', baseUrl: 'https://x.test/v1', model: 'm', unmetered: true, matryoshka: true, source: 'secret' } });
    expect(parseEmbeddingEndpoint('{"provider":"voyage"}')).toMatchObject({ ok: true, value: { provider: 'voyage' } });
  });

  it('overrides env, without inheriting the platform key', async () => {
    const env = { EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://platform', EMBEDDING_MODEL: 'pm', EMBEDDING_API_KEY: 'platform-key' };
    const cfg = await resolveEmbeddingConfig(WS, { env, loadSecret: async () => '{"baseUrl":"https://team.test/v1","model":"tm"}' });
    expect(cfg).toMatchObject({ baseUrl: 'https://team.test/v1', model: 'tm', apiKey: null, source: 'secret' });
  });

  it('can put one scope back on Voyage', async () => {
    const env = { EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://platform', EMBEDDING_MODEL: 'pm' };
    expect((await resolveEmbeddingConfig(WS, { env, loadSecret: async () => '{"provider":"voyage"}' })).provider).toBe('voyage');
  });

  it('falls back to env on no row, an invalid row, or a failed lookup', async () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      expect((await resolveEmbeddingConfig(WS, { env: {}, loadSecret: async () => null })).source).toBe('env');
      expect((await resolveEmbeddingConfig(WS, { env: {}, loadSecret: async () => '{"model":"m"}' })).source).toBe('env');
      expect((await resolveEmbeddingConfig(WS, { env: {}, loadSecret: async () => { throw new Error('db down'); } })).source).toBe('env');
    } finally {
      console.warn = orig;
    }
  });
});
