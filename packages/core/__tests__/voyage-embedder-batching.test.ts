// VoyageEmbedder request batching.
//
// Regression: a merged PR's diff ingest sent every chunk of every changed file
// to voyage-code-3 in ONE request, and the API rejected it with
// `400 TOO_MANY_TOKENS_IN_BATCH` (the model caps a request at 120K tokens).
// The embedder now splits its input into token-budgeted requests, and splits a
// request in half again if the API still says it is too big.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  VoyageEmbedder,
  estimateEmbedTokens,
  planEmbedRequests,
  VOYAGE_MAX_TEXTS_PER_REQUEST,
} from '../knowledge-store/voyage-embedder';

const realFetch = globalThis.fetch;
let requests: string[][] = [];
let respond: (input: string[]) => Response;

function okResponse(input: string[]): Response {
  return new Response(
    JSON.stringify({
      // Return out of order to prove the embedder re-sorts by index.
      data: input.map((t, index) => ({ index, embedding: [t.length, index] })).reverse(),
      model: 'voyage-code-3',
      usage: { total_tokens: 1 },
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  requests = [];
  respond = okResponse;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body.input);
    return respond(body.input);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('planEmbedRequests', () => {
  it('keeps small inputs in one request', () => {
    expect(planEmbedRequests(['a', 'b', 'c'], 1000)).toEqual([[0, 1, 2]]);
  });

  it('splits on the token budget without reordering', () => {
    const texts = ['x'.repeat(300), 'x'.repeat(300), 'x'.repeat(300)];
    const perText = estimateEmbedTokens(texts[0]);
    const plan = planEmbedRequests(texts, perText * 2);
    expect(plan).toEqual([[0, 1], [2]]);
  });

  it('gives an over-budget text a request of its own instead of dropping it', () => {
    const plan = planEmbedRequests(['small', 'x'.repeat(10_000), 'small'], 50);
    expect(plan).toEqual([[0], [1], [2]]);
  });

  it('never exceeds the per-request text cap', () => {
    const texts = Array.from({ length: VOYAGE_MAX_TEXTS_PER_REQUEST + 5 }, () => 'a');
    const plan = planEmbedRequests(texts, Number.MAX_SAFE_INTEGER);
    expect(plan.map(p => p.length)).toEqual([VOYAGE_MAX_TEXTS_PER_REQUEST, 5]);
  });
});

describe('VoyageEmbedder.embed', () => {
  it('sends a large input as several requests and returns embeddings in input order', async () => {
    const e = new VoyageEmbedder('k', 'voyage-code-3', 1024, { maxTokensPerRequest: 200 });
    // ~150 estimated tokens each: two never fit in one request.
    const texts = Array.from({ length: 5 }, (_, i) => `${i}`.padEnd(450, 'z'));
    const out = await e.embed(texts);
    expect(requests.length).toBe(5);
    expect(out).toHaveLength(5);
    // embedding[0] is the text length; every text is 450 chars.
    expect(out.every(v => v[0] === 450)).toBe(true);
    expect(requests.flat()).toEqual(texts);
  });

  it('halves and retries a request the API rejects as too many tokens', async () => {
    let first = true;
    respond = input => {
      if (first && input.length > 1) {
        first = false;
        return new Response(
          JSON.stringify({
            detail: 'The max allowed tokens per submitted batch is 120000.',
            error_code: 'TOO_MANY_TOKENS_IN_BATCH',
          }),
          { status: 400 },
        );
      }
      return okResponse(input);
    };
    const e = new VoyageEmbedder('k', 'voyage-code-3');
    const texts = ['a1', 'b22', 'c333', 'd4444'];
    const out = await e.embed(texts);
    expect(out.map(v => v[0])).toEqual([2, 3, 4, 5]);
    // One rejected request of 4, then two halves.
    expect(requests.map(r => r.length)).toEqual([4, 2, 2]);
  });

  it('surfaces any other 400 instead of retrying it', async () => {
    respond = () => new Response('{"detail":"bad input"}', { status: 400 });
    const e = new VoyageEmbedder('k', 'voyage-code-3');
    await expect(e.embed(['a', 'b'])).rejects.toThrow(/Voyage AI embedding error 400/);
    expect(requests.length).toBe(1);
  });

  it('surfaces a too-many-tokens rejection of a single text', async () => {
    respond = () =>
      new Response('{"error_code":"TOO_MANY_TOKENS_IN_BATCH"}', { status: 400 });
    const e = new VoyageEmbedder('k', 'voyage-code-3');
    await expect(e.embed(['only'])).rejects.toThrow(/TOO_MANY_TOKENS_IN_BATCH/);
  });
});
