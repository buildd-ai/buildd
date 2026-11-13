// The OpenAI-compatible embedder: request shape, auth, batching, prefixes, the
// fixed 1024-dimension store, failure as null, and the spend guard.
// Spec: docs/specs/pluggable-knowledge-store.md (section 7a).
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  OpenAICompatibleEmbedder,
  fitToStoreDimensions,
  resetEndpointQueryCache,
  STORE_DIMENSIONS,
  type OpenAICompatibleEmbedderOptions,
} from '../knowledge-store/openai-compatible-embedder';
import type { VoyageGuard, VoyageRequest } from '../knowledge-store/voyage-guard';

const CALL = { namespace: 'ws-1:memory', caller: 'test' };

function guard(allow = true) {
  const admitted: VoyageRequest[] = [];
  const settled: number[] = [];
  const g: VoyageGuard = {
    async admit(r) {
      admitted.push(r);
      return allow ? { settle: t => { settled.push(t); } } : null;
    },
  };
  return { g, admitted, settled };
}

const vec = (n: number, fill = 0.5) => Array.from({ length: n }, () => fill);

function server(respond: (body: any, init: RequestInit) => Response | Promise<Response> = body =>
  Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: vec(STORE_DIMENSIONS) })), usage: { prompt_tokens: 7, total_tokens: 7 } })) {
  const requests: Array<{ url: string; init: RequestInit; body: any }> = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url, init, body });
    return respond(body, init);
  }) as unknown as typeof fetch;
  return { f, requests };
}

function make(over: Partial<OpenAICompatibleEmbedderOptions> = {}) {
  const s = server();
  const gd = guard();
  const e = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test/v1/', model: 'qwen3-embedding', fetch: s.f, guard: gd.g, ...over });
  return { e, ...s, ...gd };
}

beforeEach(() => resetEndpointQueryCache());

describe('request shape', () => {
  it('POSTs {model, input, dimensions: 1024} to {baseUrl}/embeddings with a Bearer key', async () => {
    const { e, requests } = make({ apiKey: 'sk-test' });
    const out = await e.embed(['a', 'b'], 'document', CALL);
    expect(out).toHaveLength(2);
    expect(requests[0].url).toBe('https://embed.test/v1/embeddings');
    expect(requests[0].init.method).toBe('POST');
    expect(requests[0].body).toEqual({ model: 'qwen3-embedding', input: ['a', 'b'], dimensions: 1024 });
    expect((requests[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('sends no Authorization header without a key (a local server)', async () => {
    const { e, requests } = make();
    await e.embed(['a'], 'document', CALL);
    expect((requests[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('puts the query prefix on queries and the document prefix on documents', async () => {
    const { e, requests } = make({ queryPrefix: 'Instruct: find\nQuery: ', docPrefix: 'doc: ' });
    await e.embed(['q1'], 'query', CALL);
    await e.embed(['d1'], 'document', CALL);
    expect(requests[0].body.input).toEqual(['Instruct: find\nQuery: q1']);
    expect(requests[1].body.input).toEqual(['doc: d1']);
  });

  it('batches by input count and token budget, keeping order', async () => {
    const s = server(body => Response.json({
      // Out of order on purpose: results are put back by index.
      data: body.input.map((t: string, index: number) => ({ index, embedding: vec(STORE_DIMENSIONS, Number(t.slice(1)) / 100) })).reverse(),
    }));
    const e = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test', model: 'm', fetch: s.f, guard: guard().g, maxBatch: 2 });
    const out = await e.embed(['t1', 't2', 't3', 't4', 't5'], 'document', CALL);
    expect(s.requests.map(r => r.body.input)).toEqual([['t1', 't2'], ['t3', 't4'], ['t5']]);
    expect(out!.map(v => v[0])).toEqual([0.01, 0.02, 0.03, 0.04, 0.05]);

    const big = 'x'.repeat(30);
    const s2 = server();
    const e2 = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test', model: 'm', fetch: s2.f, guard: guard().g, maxTokensPerRequest: 15 });
    await e2.embed([big, big, big], 'document', CALL);
    expect(s2.requests.length).toBe(3);
  });

  it('shares one request for a repeated query text', async () => {
    const { e, requests } = make();
    await Promise.all([e.embed(['same'], 'query', CALL), e.embed(['same'], 'query', { ...CALL, namespace: 'ws-1:code' })]);
    expect(requests.length).toBe(1);
  });
});

describe('the fixed 1024-dimension store', () => {
  it('passes exactly 1024 through untouched', () => {
    const v = vec(1024, 0.3);
    expect(fitToStoreDimensions(v, 'm', false)).toBe(v);
  });

  it('refuses fewer than 1024 with a clear error, Matryoshka or not', () => {
    expect(() => fitToStoreDimensions(vec(768), 'small-model', false)).toThrow(/small-model returned 768 dimensions; the knowledge store needs 1024/);
    expect(() => fitToStoreDimensions(vec(768), 'small-model', true)).toThrow(/768 dimensions/);
  });

  it('refuses more than 1024 without Matryoshka', () => {
    expect(() => fitToStoreDimensions(vec(4096), 'big', false)).toThrow(/EMBEDDING_MATRYOSHKA/);
  });

  it('truncates to 1024 and L2-normalises under Matryoshka', () => {
    const v = Array.from({ length: 4096 }, (_, i) => (i % 7) - 3 + 0.25);
    const out = fitToStoreDimensions(v, 'big', true);
    expect(out.length).toBe(1024);
    const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-9);
    // Direction kept: same signs and ratios as the leading 1024.
    expect(out[1] / out[0]).toBeCloseTo(v[1] / v[0], 9);
  });

  it('embed returns null, so nothing is stored with a vector, on a wrong dimension', async () => {
    const s = server(body => Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: vec(768) })) }));
    const e = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test', model: 'm', fetch: s.f, guard: guard().g });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      expect(await e.embed(['a'], 'document', CALL)).toBeNull();
    } finally {
      console.error = orig;
    }
    expect(errors.join('\n')).toContain('768 dimensions');
  });

  it('embed truncates a longer vector end to end when Matryoshka is on', async () => {
    const s = server(body => Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: vec(2048, 2) })) }));
    const e = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test', model: 'm', fetch: s.f, guard: guard().g, matryoshka: true });
    const out = await e.embed(['a'], 'document', CALL);
    expect(out![0].length).toBe(1024);
    expect(Math.sqrt(out![0].reduce((s2, x) => s2 + x * x, 0))).toBeCloseTo(1, 9);
  });
});

describe('failure is lexical-only, never a throw', () => {
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = console.warn;
    console.warn = () => {};
    try { return await fn(); } finally { console.warn = orig; }
  };

  it('returns null on a timeout', async () => {
    const s = server((_body, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const gd = guard();
    const e = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test', model: 'm', fetch: s.f, guard: gd.g, timeoutMs: 20 });
    expect(await quiet(() => e.embed(['a'], 'query', CALL))).toBeNull();
    // Refunded: nothing was billed.
    expect(gd.settled).toEqual([0]);
  });

  it('returns null when the endpoint is down or answers an error', async () => {
    const down = new OpenAICompatibleEmbedder({
      baseUrl: 'https://embed.test', model: 'm', guard: guard().g,
      fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
    });
    expect(await quiet(() => down.embed(['a'], 'document', CALL))).toBeNull();
    const s = server(() => new Response('bad gateway', { status: 502 }));
    const e502 = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test', model: 'm', fetch: s.f, guard: guard().g });
    expect(await quiet(() => e502.embed(['a'], 'document', CALL))).toBeNull();
  });

  it('returns null on a short or malformed response', async () => {
    const s = server(() => Response.json({ data: [] }));
    const e = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test', model: 'm', fetch: s.f, guard: guard().g });
    expect(await quiet(() => e.embed(['a', 'b'], 'document', CALL))).toBeNull();
  });

  it('a failed query is not cached', async () => {
    let fail = true;
    const s = server(body => fail
      ? new Response('nope', { status: 500 })
      : Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: vec(1024) })) }));
    const e = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test', model: 'm', fetch: s.f, guard: guard().g });
    expect(await quiet(() => e.embed(['q'], 'query', CALL))).toBeNull();
    fail = false;
    expect(await e.embed(['q'], 'query', CALL)).toHaveLength(1);
  });
});

describe('spend guard', () => {
  it('admits with the provider recorded and settles the reported tokens', async () => {
    const { e, admitted, settled } = make({ docPrefix: 'p: ' });
    await e.embed(['abcdef'], 'document', CALL);
    expect(admitted[0]).toMatchObject({
      namespace: 'ws-1:memory', caller: 'test', kind: 'embed', model: 'qwen3-embedding', inputType: 'document',
      provider: 'openai_compat', unmetered: false,
      // The prefix is sent, so it is estimated too: 'p: abcdef' is 9 chars.
      estimatedTokens: 3,
    });
    expect(settled).toEqual([7]);
  });

  it('marks a free endpoint unmetered, and settles the estimate when the server reports no usage', async () => {
    const s = server(body => Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: vec(1024) })) }));
    const gd = guard();
    const e = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test', model: 'm', fetch: s.f, guard: gd.g, unmetered: true });
    await e.embed(['abcdef'], 'document', CALL);
    expect(gd.admitted[0].unmetered).toBe(true);
    expect(gd.settled).toEqual([2]);
  });

  it('makes no request when the guard refuses', async () => {
    const s = server();
    const e = new OpenAICompatibleEmbedder({ baseUrl: 'https://embed.test', model: 'm', fetch: s.f, guard: guard(false).g });
    expect(await e.embed(['a'], 'document', CALL)).toBeNull();
    expect(s.requests).toEqual([]);
  });
});
