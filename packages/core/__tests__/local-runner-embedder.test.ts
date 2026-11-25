// Embeddings on the relay (docs/specs/local-runner-provider.md §7.1, AC-24,
// AC-25, M11): a `local_runner` pick embeds through the relay queue, degrades
// to lexical-only (null) on every failure, and never reaches a paid vendor.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LocalRunnerEmbedder } from '../knowledge-store/local-runner-embedder';
import { getEmbedderForCorpus, resolveEmbeddingConfig } from '../knowledge-store/embedding-config';
import type { LocalRunnerPick, RunRelayJobInput, RunRelayJobOutcome } from '../model-relay';
import type { VoyageGuard } from '../knowledge-store/voyage-guard';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WS = '55555555-5555-4555-8555-555555555555';
const RUNNER = '22222222-2222-4222-8222-222222222222';

const settled: number[] = [];
const guard: VoyageGuard = {
  admit: async () => ({ settle: (n: number) => { settled.push(n); } }),
} as unknown as VoyageGuard;

const vec = (n: number, fill = 0.5) => Array.from({ length: n }, () => fill);

function embedder(run: (input: RunRelayJobInput) => Promise<RunRelayJobOutcome>, over: Record<string, unknown> = {}) {
  const jobs: RunRelayJobInput[] = [];
  const e = new LocalRunnerEmbedder({
    teamId: TEAM, workspaceId: WS, runnerId: RUNNER, model: 'nomic-embed-text', dimensions: 768, guard,
    run: async (input) => { jobs.push(input); return run(input); },
    ...over,
  });
  return { e, jobs };
}

// Any outbound request is a paid fallback by another door: fail the test on one.
const realFetch = globalThis.fetch;
let fetched: string[] = [];
beforeEach(() => {
  settled.length = 0;
  fetched = [];
  globalThis.fetch = (async (input: unknown) => { fetched.push(String(input)); throw new Error('no network in this test'); }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  expect(fetched).toEqual([]);
});

describe('LocalRunnerEmbedder', () => {
  it('embeds through one relay job per batch, at the namespace size, on the surface that asked', async () => {
    const { e, jobs } = embedder(async (input) => ({
      ok: true, runnerId: RUNNER,
      result: { vectors: (input.payload as any).inputs.map(() => vec(768)), dimensions: 768, model: 'nomic-embed-text', promptTokens: 7 },
    }));
    const out = await e.embed(['a', 'b'], 'document', { namespace: `${WS}:code`, caller: 'ingest_batch' });
    expect(out).toHaveLength(2);
    expect(out![0]).toHaveLength(768);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      teamId: TEAM, workspaceId: WS, kind: 'embed', surface: 'ingest', namespace: `${WS}:code`, model: 'nomic-embed-text',
      payload: { inputs: ['a', 'b'], inputType: 'document', dimensions: 768 },
    });
    expect(settled).toEqual([7]);
  });

  it('a query is surface query; a re-embed walk is surface reembed', async () => {
    const ok = async (input: RunRelayJobInput): Promise<RunRelayJobOutcome> => ({ ok: true, runnerId: RUNNER, result: { vectors: (input.payload as any).inputs.map(() => vec(768)), dimensions: 768, model: 'm' } });
    const q = embedder(ok);
    await q.e.embed(['what'], 'query', { namespace: `${WS}:memory`, caller: 'recall' });
    expect(q.jobs[0]!.surface).toBe('query');
    const r = embedder(ok);
    await r.e.embed(['doc'], 'document', { namespace: `${WS}:memory`, caller: 'reembed' });
    expect(r.jobs[0]!.surface).toBe('reembed');
  });

  it('splits more inputs than one batch holds and keeps their order', async () => {
    const { e, jobs } = embedder(async (input) => ({
      ok: true, runnerId: RUNNER,
      result: { vectors: (input.payload as any).inputs.map((t: string) => vec(768, Number(t))), dimensions: 768, model: 'm' },
    }));
    const texts = Array.from({ length: 70 }, (_, i) => String(i));
    const out = await e.embed(texts, 'document', { namespace: `${WS}:code`, caller: 'ingest' });
    expect(jobs.map(j => (j.payload as any).inputs.length)).toEqual([32, 32, 6]);
    expect(out!.map(v => v[0])).toEqual(texts.map(Number));
  });

  it('AC-24/AC-25: an offline runner is null (lexical-only), with no vendor request', async () => {
    const { e } = embedder(async () => ({ ok: false, code: 'runner_offline', message: 'The chosen runner is offline.', runnerId: RUNNER }));
    expect(await e.embed(['a'], 'document', { namespace: `${WS}:code`, caller: 'ingest' })).toBeNull();
    expect(await e.embed(['a'], 'query', { namespace: `${WS}:code`, caller: 'recall' })).toBeNull();
    expect(settled).toEqual([0, 0]);
  });

  it('a failed batch stops the walk: no later batch is sent and nothing is returned', async () => {
    let n = 0;
    const { e, jobs } = embedder(async (input) => (++n === 1
      ? { ok: true, runnerId: RUNNER, result: { vectors: (input.payload as any).inputs.map(() => vec(768)), dimensions: 768, model: 'm' } }
      : { ok: false, code: 'timeout', message: 'slow', runnerId: RUNNER }));
    expect(await e.embed(Array.from({ length: 96 }, (_, i) => `t${i}`), 'document', { namespace: `${WS}:code`, caller: 'ingest' })).toBeNull();
    expect(jobs).toHaveLength(2);
  });

  it('a vector of another size is refused, never padded or cut', async () => {
    const { e } = embedder(async () => ({ ok: true, runnerId: RUNNER, result: { vectors: [vec(1024)], dimensions: 1024, model: 'm' } }));
    expect(await e.embed(['a'], 'document', { namespace: `${WS}:code`, caller: 'ingest' })).toBeNull();
  });

  it('never throws: a relay that throws and a guard that refuses are both null', async () => {
    const thrower = embedder(async () => { throw new Error('boom'); });
    expect(await thrower.e.embed(['a'], 'document', { namespace: `${WS}:code`, caller: 'ingest' })).toBeNull();
    let ran = 0;
    const refused = embedder(async () => { ran++; return { ok: false, code: 'runner_offline', message: '', runnerId: RUNNER }; }, { guard: { admit: async () => null } });
    expect(await refused.e.embed(['a'], 'document', { namespace: `${WS}:code`, caller: 'ingest' })).toBeNull();
    expect(ran).toBe(0);
  });

  it('no texts: no job', async () => {
    const { e, jobs } = embedder(async () => ({ ok: false, code: 'runner_offline', message: '', runnerId: RUNNER }));
    expect(await e.embed([], 'document', { namespace: `${WS}:code`, caller: 'ingest' })).toEqual([]);
    expect(jobs).toHaveLength(0);
  });
});

describe('resolveEmbeddingConfig for a local_runner pick', () => {
  const advert = (dimensions: number | null, capabilities = ['embedding']) => ({
    server: { kind: 'ollama' as const, version: null, reachable: true, checkedAt: null },
    models: [{ name: 'nomic-embed-text', family: null, parameterSize: null, capabilities: capabilities as any, dimensions, contextLength: null }],
  });
  const pick = (over: Partial<LocalRunnerPick> = {}): LocalRunnerPick => ({
    teamId: TEAM, runnerId: RUNNER, chatModel: null, embeddingModel: 'nomic-embed-text', chatAssigned: false,
    runner: { id: RUNNER, accountId: 'acc-1', lastHeartbeatAt: new Date(0), presenceConnected: false, localModels: advert(768) },
    ...over,
  });
  const resolve = (p: LocalRunnerPick | null) => {
    let credentialLookups = 0;
    const cfg = resolveEmbeddingConfig(WS, {
      env: { EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://paid.example/v1', EMBEDDING_MODEL: 'paid', VOYAGE_API_KEY: 'vk' },
      loadSetting: async () => ({ teamId: TEAM, workspaceId: WS, provider: 'local_runner', model: 'nomic-embed-text' }),
      resolveCredential: async () => { credentialLookups++; return { apiKey: 'sk-paid', baseUrl: null }; },
      loadLegacySecret: async () => { credentialLookups++; return null; },
      loadLocalRunnerPick: async () => p,
    });
    return cfg.then(c => ({ cfg: c, credentialLookups: () => credentialLookups }));
  };

  it('carries the pinned runner, the model and the advertised size; no credential is looked up', async () => {
    const { cfg, credentialLookups } = await resolve(pick());
    expect(cfg).toMatchObject({
      provider: 'local_runner', model: 'nomic-embed-text', apiKey: null, baseUrl: null, unmetered: true, source: 'team', unavailable: null,
      localRunner: { teamId: TEAM, workspaceId: WS, runnerId: RUNNER, dimensions: 768 },
    });
    expect(credentialLookups()).toBe(0);
    // An offline runner still resolves: whether it is online is asked per call, so the namespace's space never flaps.
    const e = getEmbedderForCorpus('code', cfg, null);
    expect(e).toBeInstanceOf(LocalRunnerEmbedder);
    expect(e).toMatchObject({ model: 'nomic-embed-text', dimensions: 768 });
    expect(getEmbedderForCorpus('memory', cfg, null)).toBe(e);
  });

  it('never falls back: with no runner, a gone runner, an unadvertised model or an unsupported size the namespace is lexical-only', async () => {
    const cases: Array<[LocalRunnerPick | null, RegExp]> = [
      [null, /no runner is chosen/i],
      [pick({ runnerId: null, runner: null }), /no runner is chosen/i],
      [pick({ runner: null }), new RegExp(RUNNER)],
      [pick({ runner: { ...pick().runner!, localModels: null } }), /has not reported its local models/i],
      [pick({ runner: { ...pick().runner!, localModels: advert(768, ['completion']) } }), /does not serve nomic-embed-text/],
      [pick({ runner: { ...pick().runner!, localModels: advert(384) } }), /384.*not supported/],
      [pick({ runner: { ...pick().runner!, localModels: advert(null) } }), /did not report/i],
    ];
    for (const [p, reason] of cases) {
      const { cfg, credentialLookups } = await resolve(p);
      expect(cfg.provider).toBe('local_runner');
      expect(cfg.unavailable).toMatch(reason);
      // A voyage fallback embedder is offered and must not be used.
      const fallback = { model: 'voyage-code-3', dimensions: 1024, embed: async () => { throw new Error('paid fallback used'); } };
      expect(getEmbedderForCorpus('code', cfg, fallback)).toBeNull();
      expect(credentialLookups()).toBe(0);
    }
  });

  it('a pick lookup that throws is lexical-only, not the env default', async () => {
    const cfg = await resolveEmbeddingConfig(WS, {
      env: { EMBEDDING_PROVIDER: 'openai_compat', EMBEDDING_BASE_URL: 'https://paid.example/v1', EMBEDDING_MODEL: 'paid' },
      loadSetting: async () => ({ teamId: TEAM, workspaceId: WS, provider: 'local_runner', model: 'nomic-embed-text' }),
      loadLocalRunnerPick: async () => { throw new Error('db down'); },
    });
    expect(cfg.provider).toBe('local_runner');
    expect(cfg.unavailable).toBeTruthy();
  });
});
