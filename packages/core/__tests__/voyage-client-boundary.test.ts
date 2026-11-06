// Every Voyage request goes through the guard, in both clients, and a denial
// costs nothing. Also pins the spend reductions that live in the clients.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import { VoyageEmbedder, resetQueryEmbeddingCache } from '../knowledge-store/voyage-embedder';
import {
  RERANK_MAX_DOC_CHARS,
  RERANK_MAX_QUERY_CHARS,
  VoyageReranker,
  applyRerank,
} from '../knowledge-store/reranker';
import type { VoyageGuard, VoyageRequest } from '../knowledge-store/voyage-guard';
import type { QueryResult } from '../knowledge-store/types';

const CALL = { namespace: 'ws-1:memory', caller: 'test' };
const realFetch = globalThis.fetch;
let bodies: any[] = [];
let auth: string[] = [];

function fakeGuard(allow = true) {
  const seen: VoyageRequest[] = [];
  const settled: number[] = [];
  const guard: VoyageGuard = {
    async admit(r) {
      seen.push(r);
      return allow ? { settle: t => { settled.push(t); } } : null;
    },
  };
  return { guard, seen, settled };
}

beforeEach(() => {
  bodies = [];
  auth = [];
  resetQueryEmbeddingCache();
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    auth.push(String((init?.headers as Record<string, string>)?.Authorization));
    if (String(url).endsWith('/rerank')) {
      return new Response(JSON.stringify({
        data: body.documents.map((_: string, index: number) => ({ index, relevance_score: 1 - index / 100 })),
        model: 'rerank-2.5',
        usage: { total_tokens: 77 },
      }));
    }
    return new Response(JSON.stringify({
      data: body.input.map((t: string, index: number) => ({ index, embedding: [t.length] })),
      model: body.model,
      usage: { total_tokens: 11 },
    }));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('VoyageEmbedder through the guard', () => {
  it('asks before calling and settles real usage', async () => {
    const { guard, seen, settled } = fakeGuard();
    const e = new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard });
    await e.embed(['abc'], 'document', CALL);
    expect(seen[0]).toMatchObject({ kind: 'embed', namespace: 'ws-1:memory', caller: 'test', model: 'voyage-4-large', inputType: 'document', estimatedTokens: 1 });
    expect(settled).toEqual([11]);
  });

  it('sums usage across split requests into one settle', async () => {
    const { guard, settled } = fakeGuard();
    const e = new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard, maxTokensPerRequest: 1 });
    await e.embed(['abc', 'def', 'ghi'], 'document', CALL);
    expect(bodies.length).toBe(3);
    expect(settled).toEqual([33]);
  });

  it('makes no request and returns null when denied', async () => {
    const { guard } = fakeGuard(false);
    const e = new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard });
    expect(await e.embed(['abc'], 'document', CALL)).toBeNull();
    expect(bodies).toEqual([]);
  });

  it('refunds the reservation when the request fails', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const { guard, settled } = fakeGuard();
    const e = new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard });
    await expect(e.embed(['abc'], 'document', CALL)).rejects.toThrow();
    expect(settled).toEqual([0]);
  });
});

describe('whose key', () => {
  const own: VoyageGuard = { admit: async () => ({ apiKey: 'team-key', settle: () => {} }) };

  it('embeds on the team key when the permit carries one', async () => {
    await new VoyageEmbedder('platform-key', 'voyage-4-large', 1024, { guard: own }).embed(['abc'], 'document', CALL);
    expect(auth).toEqual(['Bearer team-key']);
  });

  it('reranks on the team key when the permit carries one', async () => {
    await new VoyageReranker('platform-key', 'rerank-2.5', { guard: own }).rerank('q', ['a'], 1, CALL);
    expect(auth).toEqual(['Bearer team-key']);
  });

  it('uses the platform key otherwise', async () => {
    const { guard } = fakeGuard();
    await new VoyageEmbedder('platform-key', 'voyage-4-large', 1024, { guard }).embed(['abc'], 'document', CALL);
    expect(auth).toEqual(['Bearer platform-key']);
  });
});

describe('query embedding cache', () => {
  it('collapses a concurrent fan-out into one request', async () => {
    const { guard, seen } = fakeGuard();
    const e = new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard });
    const out = await Promise.all(
      ['ws-1:memory', 'ws-1:plan', 'ws-1:task', 'ws-1:pr'].map(namespace => e.embed(['same text'], 'query', { namespace, caller: 'claim' })),
    );
    expect(bodies.length).toBe(1);
    expect(seen.length).toBe(1);
    expect(out.every(v => v?.[0]?.[0] === 'same text'.length)).toBe(true);
  });

  it('serves a repeat without a request', async () => {
    const { guard } = fakeGuard();
    const e = new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard });
    await e.embed(['again'], 'query', CALL);
    await e.embed(['again'], 'query', CALL);
    expect(bodies.length).toBe(1);
  });

  it('keeps models apart', async () => {
    const { guard } = fakeGuard();
    await new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard }).embed(['t'], 'query', CALL);
    await new VoyageEmbedder('k', 'voyage-code-3', 1024, { guard }).embed(['t'], 'query', CALL);
    expect(bodies.length).toBe(2);
  });

  it('embeds only the misses of a batch, in order', async () => {
    const { guard } = fakeGuard();
    const e = new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard });
    await e.embed(['aa'], 'query', CALL);
    const out = await e.embed(['aa', 'bbb'], 'query', CALL);
    expect(bodies[1].input).toEqual(['bbb']);
    expect(out).toEqual([[2], [3]]);
  });

  it('never caches documents', async () => {
    const { guard } = fakeGuard();
    const e = new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard });
    await e.embed(['doc'], 'document', CALL);
    await e.embed(['doc'], 'document', CALL);
    expect(bodies.length).toBe(2);
  });

  it('does not cache a denial', async () => {
    let allow = false;
    const guard: VoyageGuard = { admit: async () => (allow ? { settle: () => {} } : null) };
    const e = new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard });
    expect(await e.embed(['later'], 'query', CALL)).toBeNull();
    allow = true;
    expect(await e.embed(['later'], 'query', CALL)).toEqual([[5]]);
  });

  it('does not cache a failure', async () => {
    const good = globalThis.fetch;
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const { guard } = fakeGuard();
    const e = new VoyageEmbedder('k', 'voyage-4-large', 1024, { guard });
    await expect(e.embed(['retry'], 'query', CALL)).rejects.toThrow();
    globalThis.fetch = good;
    expect(await e.embed(['retry'], 'query', CALL)).toEqual([[5]]);
  });
});

describe('VoyageReranker through the guard', () => {
  it('asks before calling and settles real usage', async () => {
    const { guard, seen, settled } = fakeGuard();
    const r = new VoyageReranker('k', 'rerank-2.5', { guard });
    await r.rerank('q'.repeat(30), ['abc', 'def'], 2, CALL);
    expect(seen[0]).toMatchObject({ kind: 'rerank', model: 'rerank-2.5', namespace: 'ws-1:memory', estimatedTokens: 22 });
    expect(settled).toEqual([77]);
  });

  it('makes no request and returns null when denied', async () => {
    const { guard } = fakeGuard(false);
    const r = new VoyageReranker('k', 'rerank-2.5', { guard });
    expect(await r.rerank('q', ['a', 'b'], 2, CALL)).toBeNull();
    expect(bodies).toEqual([]);
  });

  it('trims the query and each document before sending', async () => {
    const { guard, seen } = fakeGuard();
    const r = new VoyageReranker('k', 'rerank-2.5', { guard });
    await r.rerank('q'.repeat(RERANK_MAX_QUERY_CHARS * 3), ['d'.repeat(RERANK_MAX_DOC_CHARS * 3), 'short'], 2, CALL);
    expect(bodies[0].query.length).toBe(RERANK_MAX_QUERY_CHARS);
    expect(bodies[0].documents[0].length).toBe(RERANK_MAX_DOC_CHARS);
    expect(bodies[0].documents[1]).toBe('short');
    // The estimate is of what is sent, not of what was passed in.
    expect(seen[0].estimatedTokens).toBeLessThan(RERANK_MAX_QUERY_CHARS + RERANK_MAX_DOC_CHARS);
  });
});

describe('applyRerank', () => {
  const hit = (id: string, score: number) => ({ id, content: id, score }) as unknown as QueryResult;

  it('returns null when the reranker declined, leaving the caller its order', async () => {
    const reranker = { model: 'm', rerank: async () => null };
    expect(await applyRerank(reranker, 'q', [hit('a', 1), hit('b', 0.5)], 2, CALL)).toBeNull();
  });
});

describe('one door', () => {
  it('only the two clients name a Voyage endpoint', () => {
    const out = execSync(
      `git grep -l "api.voyageai.com" -- 'apps/*' 'packages/*' ':!*.test.ts' ':!*.md'`,
      { encoding: 'utf8', cwd: `${import.meta.dir}/../../..` },
    );
    expect(out.trim().split('\n').sort()).toEqual([
      'packages/core/knowledge-store/reranker.ts',
      'packages/core/knowledge-store/voyage-embedder.ts',
    ]);
  });
});
