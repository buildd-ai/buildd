// Which embedder a namespace gets: env (the operator default) or the provider
// the team picked for embeddings on Settings › Providers. Spec: docs/specs/pluggable-knowledge-store.md.
import { afterEach, describe, expect, it } from 'bun:test';
import {
  embeddingConfigFromEnv,
  getEmbedderForCorpus,
  resolveEmbeddingConfig,
} from '../knowledge-store/embedding-config';
import { OpenAICompatibleEmbedder } from '../knowledge-store/openai-compatible-embedder';
import { VoyageEmbedder } from '../knowledge-store/voyage-embedder';

const WS = '00000000-0000-4000-8000-000000000001';
const TEAM = '00000000-0000-4000-8000-0000000000aa';
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
    const cfg = await resolveEmbeddingConfig('ws-1', { env: {}, loadSetting: async () => { looked = true; return null; } });
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

describe('a team picks one of its providers', () => {
  const quiet = async <T>(fn: () => Promise<T>) => {
    const orig = console.warn;
    const warned: string[] = [];
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
    try { return { value: await fn(), warned }; } finally { console.warn = orig; }
  };
  const setting = (provider: string | null, model: string | null, workspaceId: string | null = WS) =>
    async () => ({ teamId: TEAM, workspaceId, provider, model });

  it('no pick: the deployment default, Voyage, with no credential lookup', async () => {
    let looked = false;
    const cfg = await resolveEmbeddingConfig(WS, {
      env: {}, loadSetting: setting(null, null), resolveCredential: async () => { looked = true; return null; }, loadLegacySecret: async () => null,
    });
    expect(cfg.provider).toBe('voyage');
    expect(cfg.source).toBe('env');
    expect(looked).toBe(false);
  });

  it('no pick under an operator openai_compat default: env, as before', async () => {
    const env = { EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://platform.test/v1', EMBEDDING_MODEL: 'pm' };
    const cfg = await resolveEmbeddingConfig(WS, { env, loadSetting: async () => null, loadLegacySecret: async () => null });
    expect(cfg).toMatchObject({ provider: 'openai_compat', baseUrl: 'https://platform.test/v1', model: 'pm', source: 'env' });
  });

  it("OpenRouter: the team's stored OpenRouter key and OpenRouter's root, never the platform key", async () => {
    const env = { EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://platform.test/v1', EMBEDDING_MODEL: 'pm', EMBEDDING_API_KEY: 'platform-key' };
    const asked: unknown[] = [];
    const cfg = await resolveEmbeddingConfig(WS, {
      env,
      loadSetting: setting('openrouter', 'openai/text-embedding-3-large'),
      resolveCredential: async (provider, scope) => { asked.push({ provider, ...scope }); return { apiKey: 'sk-or-team', baseUrl: null }; },
    });
    expect(asked).toEqual([{ provider: 'openrouter', teamId: TEAM, workspaceId: WS }]);
    expect(cfg).toMatchObject({
      provider: 'openai_compat', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/text-embedding-3-large',
      apiKey: 'sk-or-team', source: 'team', unavailable: null,
    });
    const e = getEmbedderForCorpus('memory', cfg, fallback);
    expect(e).toBeInstanceOf(OpenAICompatibleEmbedder);
    expect(e!.model).toBe('openai/text-embedding-3-large');
  });

  it("a gateway: the gateway credential's base URL and key", async () => {
    const cfg = await resolveEmbeddingConfig(WS, {
      env: {},
      loadSetting: setting('litellm', 'qwen3-embedding'),
      resolveCredential: async () => ({ apiKey: 'gw-key', baseUrl: 'https://gw.example.test/v1' }),
    });
    expect(cfg).toMatchObject({ provider: 'openai_compat', baseUrl: 'https://gw.example.test/v1', model: 'qwen3-embedding', apiKey: 'gw-key', source: 'team' });
  });

  it('a team-wide namespace (team id as owner) resolves with no workspace', async () => {
    const asked: unknown[] = [];
    await resolveEmbeddingConfig(TEAM, {
      env: {},
      loadSetting: setting('openai', 'text-embedding-3-large', null),
      resolveCredential: async (provider, scope) => { asked.push(scope); return { apiKey: 'sk-team', baseUrl: null }; },
    });
    expect(asked).toEqual([{ teamId: TEAM, workspaceId: null }]);
  });

  it('Voyage picked explicitly: Voyage, as the default is', async () => {
    const cfg = await resolveEmbeddingConfig(WS, {
      env: { EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://p', EMBEDDING_MODEL: 'pm' },
      loadSetting: setting('voyage', null),
    });
    expect(cfg).toMatchObject({ provider: 'voyage', source: 'team' });
  });

  it('a picked provider with no stored key: a clear reason, and lexical-only rather than a failed ingest', async () => {
    const { value: cfg } = await quiet(() => resolveEmbeddingConfig(WS, {
      env: {}, loadSetting: setting('openrouter', 'openai/text-embedding-3-large'), resolveCredential: async () => null,
    }));
    expect(cfg.source).toBe('team');
    expect(cfg.unavailable).toBe('OpenRouter is chosen for embeddings but has no usable key for this team or workspace; knowledge runs lexical-only.');
    const { value: embedder, warned } = await quiet(async () => getEmbedderForCorpus('code', cfg, fallback));
    expect(embedder).toBeNull();
    expect(warned.join('\n')).toContain('has no usable key');
  });

  it('a failed credential lookup is the same: lexical-only, never a throw', async () => {
    const { value: cfg } = await quiet(() => resolveEmbeddingConfig(WS, {
      env: {}, loadSetting: setting('openai', 'text-embedding-3-large'), resolveCredential: async () => { throw new Error('db down'); },
    }));
    expect(cfg.unavailable).toContain('OpenAI');
    expect(getEmbedderForCorpus('memory', cfg, fallback)).toBeNull();
  });

  it('a failed setting lookup falls back to env', async () => {
    const { value: cfg } = await quiet(() => resolveEmbeddingConfig(WS, { env: {}, loadSetting: async () => { throw new Error('db down'); } }));
    expect(cfg.source).toBe('env');
  });
});

describe('legacy embedding_endpoint rows: read-only, deprecated', () => {
  it('a team with no pick and an old row keeps it, with a deprecation warning', async () => {
    const orig = console.warn;
    const warned: string[] = [];
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
    try {
      const cfg = await resolveEmbeddingConfig(WS, {
        env: {}, loadSetting: async () => null, loadLegacySecret: async () => '{"baseUrl":"https://old.test/v1","model":"om"}',
      });
      expect(cfg).toMatchObject({ provider: 'openai_compat', baseUrl: 'https://old.test/v1', model: 'om', source: 'secret' });
      expect(warned.join('\n')).toContain('deprecated');
    } finally {
      console.warn = orig;
    }
  });

  it("a team's pick wins over an old row", async () => {
    let read = false;
    const cfg = await resolveEmbeddingConfig(WS, {
      env: {},
      loadSetting: async () => ({ teamId: TEAM, workspaceId: WS, provider: 'voyage', model: null }),
      loadLegacySecret: async () => { read = true; return '{"baseUrl":"https://old.test/v1","model":"om"}'; },
    });
    expect(cfg.provider).toBe('voyage');
    expect(read).toBe(false);
  });

  it('an invalid old row is ignored', async () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      const cfg = await resolveEmbeddingConfig(WS, { env: {}, loadSetting: async () => null, loadLegacySecret: async () => '{"model":"m"}' });
      expect(cfg.source).toBe('env');
    } finally {
      console.warn = orig;
    }
  });
});
