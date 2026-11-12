import type { Embedder, EmbedInputType, Corpus } from './types';
import { estimateTextTokens } from '../voyage-budget';
import { getVoyageGuard, type VoyageCall, type VoyageGuard } from './voyage-guard';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const DEFAULT_MODEL = 'voyage-4-large';
const DEFAULT_DIMENSIONS = 1024;

export type VoyageModel = 'voyage-4-large' | 'voyage-code-3';

const CODE_CORPORA = new Set<Corpus>(['code', 'docs', 'spec']);

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

/**
 * Voyage caps one embeddings request at 120K tokens (voyage-code-3; other
 * models are higher) and 1000 inputs. A diff or file batch that is chunked
 * into one request can blow past the token cap — the API answers
 * `400 TOO_MANY_TOKENS_IN_BATCH` and the whole ingest fails — so requests are
 * planned against a budget well under it.
 */
export const VOYAGE_MAX_TEXTS_PER_REQUEST = 1000;
/** Estimated-token budget per request. Leaves headroom for a dense tokenizer. */
export const DEFAULT_MAX_TOKENS_PER_REQUEST = 80_000;

/**
 * Conservative token estimate: ~3 characters per token. Real code and prose
 * tokenize closer to 3.5–4, so this over-counts, which is the safe direction.
 */
export function estimateEmbedTokens(text: string): number {
  return estimateTextTokens(text);
}

/**
 * Group input indexes into requests that each stay under `maxTokens` and the
 * per-request text cap, preserving order. A text that alone exceeds the budget
 * still gets a request of its own (Voyage truncates an over-long input; it is
 * the batch total that gets rejected). `maxTexts` caps inputs per request
 * (default Voyage's 1000; an OpenAI-compatible server is often far lower).
 */
export function planEmbedRequests(texts: string[], maxTokens: number, maxTexts = VOYAGE_MAX_TEXTS_PER_REQUEST): number[][] {
  const plan: number[][] = [];
  let current: number[] = [];
  let currentTokens = 0;
  texts.forEach((text, i) => {
    const tokens = estimateEmbedTokens(text);
    if (
      current.length > 0 &&
      (currentTokens + tokens > maxTokens || current.length >= maxTexts)
    ) {
      plan.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(i);
    currentTokens += tokens;
  });
  if (current.length > 0) plan.push(current);
  return plan;
}

class VoyageRequestError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Voyage AI embedding error ${status}: ${body}`);
  }

  get tooManyTokens(): boolean {
    return this.status === 400 && /TOO_MANY_TOKENS/i.test(this.body);
  }
}

export interface VoyageEmbedderOptions {
  /** Estimated-token budget per request (default DEFAULT_MAX_TOKENS_PER_REQUEST). */
  maxTokensPerRequest?: number;
  /** The spend guard (default: the process-wide one over the database). */
  guard?: VoyageGuard;
}

/**
 * Query embeddings, by model and text. A claim or a multi-corpus recall sends
 * the same text to every corpus; the entries are promises, so that concurrent
 * fan-out shares one request as well as a later repeat. A vector depends only
 * on the model and the text, so entries are safe to share between teams.
 */
const QUERY_CACHE_MAX = 1_000;
const QUERY_CACHE_TTL_MS = 15 * 60 * 1000;
const queryCache = new Map<string, { at: number; vector: Promise<number[] | null> }>();

/** Drop every cached query embedding. Tests only. */
export function resetQueryEmbeddingCache(): void {
  queryCache.clear();
}

/**
 * Embedder backed by Voyage AI. Both voyage-4-large and voyage-code-3 output
 * 1024 dimensions, so the shared HNSW index requires no structural change.
 *
 * Supports asymmetric retrieval via `input_type`: pass `'query'` when embedding
 * search text and `'document'` (the default) when embedding stored chunks.
 *
 * Large inputs are split into several requests (see planEmbedRequests); a
 * request the API still rejects as too many tokens is halved and retried.
 *
 * Requires VOYAGE_API_KEY env var. Returns null from getVoyageEmbedder() when
 * the key is not present; callers should fall back to lexical-only mode.
 */
export class VoyageEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly maxTokensPerRequest: number;
  private readonly guard: VoyageGuard | undefined;

  constructor(
    private readonly apiKey: string,
    model: VoyageModel = DEFAULT_MODEL,
    dimensions = DEFAULT_DIMENSIONS,
    opts: VoyageEmbedderOptions = {},
  ) {
    this.model = model;
    this.dimensions = dimensions;
    this.maxTokensPerRequest = opts.maxTokensPerRequest ?? DEFAULT_MAX_TOKENS_PER_REQUEST;
    this.guard = opts.guard;
  }

  /**
   * Embed `texts`, or return null when the spend guard refuses: the caller then
   * stores or searches without vectors. Nothing reaches Voyage without a permit.
   */
  async embed(texts: string[], inputType: EmbedInputType, call: VoyageCall): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    return inputType === 'query' ? this.embedQueries(texts, call) : this.embedGuarded(texts, inputType, call);
  }

  private async embedQueries(texts: string[], call: VoyageCall): Promise<number[][] | null> {
    const now = Date.now();
    const key = (t: string) => `${this.model}\0${t}`;
    const fresh = (t: string) => {
      const hit = queryCache.get(key(t));
      return hit && now - hit.at < QUERY_CACHE_TTL_MS ? hit : undefined;
    };
    const misses = [...new Set(texts)].filter(t => !fresh(t));
    if (misses.length > 0) {
      const batch = this.embedGuarded(misses, 'query', call);
      misses.forEach((t, i) => {
        const k = key(t);
        const vector = batch.then(vectors => vectors?.[i] ?? null);
        if (queryCache.size >= QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value as string);
        queryCache.delete(k);
        const entry = { at: now, vector };
        queryCache.set(k, entry);
        // A denial or a failure is not an answer worth keeping.
        const evict = () => { if (queryCache.get(k) === entry) queryCache.delete(k); };
        vector.then(v => { if (!v) evict(); }, evict);
      });
    }
    const vectors = await Promise.all(texts.map(t => queryCache.get(key(t))!.vector));
    return vectors.some(v => !v) ? null : (vectors as number[][]);
  }

  private async embedGuarded(texts: string[], inputType: EmbedInputType, call: VoyageCall): Promise<number[][] | null> {
    const permit = await (this.guard ?? getVoyageGuard()).admit({
      ...call,
      kind: 'embed',
      model: this.model,
      inputType,
      estimatedTokens: texts.reduce((sum, t) => sum + estimateEmbedTokens(t), 0),
    });
    if (!permit) return null;

    const usage = { tokens: 0 };
    try {
      const out: number[][] = new Array(texts.length);
      for (const indexes of planEmbedRequests(texts, this.maxTokensPerRequest)) {
        const vectors = await this.embedSplittingOnOverflow(indexes.map(i => texts[i]), inputType, usage, permit.apiKey ?? this.apiKey);
        indexes.forEach((textIndex, j) => {
          out[textIndex] = vectors[j];
        });
      }
      return out;
    } finally {
      // On a failure part-way, this is what Voyage actually billed: 0 if nothing.
      permit.settle(usage.tokens);
    }
  }

  /** One request; on a too-many-tokens rejection, halve and retry each half. */
  private async embedSplittingOnOverflow(
    texts: string[],
    inputType: EmbedInputType,
    usage: { tokens: number },
    apiKey: string,
  ): Promise<number[][]> {
    try {
      return await this.request(texts, inputType, usage, apiKey);
    } catch (err) {
      if (!(err instanceof VoyageRequestError) || !err.tooManyTokens || texts.length < 2) throw err;
      const mid = Math.ceil(texts.length / 2);
      const left = await this.embedSplittingOnOverflow(texts.slice(0, mid), inputType, usage, apiKey);
      const right = await this.embedSplittingOnOverflow(texts.slice(mid), inputType, usage, apiKey);
      return [...left, ...right];
    }
  }

  private async request(texts: string[], inputType: EmbedInputType, usage: { tokens: number }, apiKey: string): Promise<number[][]> {
    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: inputType,
      }),
    });

    if (!res.ok) {
      throw new VoyageRequestError(res.status, await res.text());
    }

    const data = (await res.json()) as VoyageResponse;
    usage.tokens += data.usage?.total_tokens ?? 0;
    // Sort by index to preserve original order
    return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  }
}

// Per-model singletons — keyed by model name
const _embedders = new Map<string, VoyageEmbedder>();

/** Return singleton VoyageEmbedder for the given model, or null if VOYAGE_API_KEY is not set. */
export function getVoyageEmbedder(model: VoyageModel = 'voyage-4-large'): VoyageEmbedder | null {
  const cached = _embedders.get(model);
  if (cached) return cached;
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  const embedder = new VoyageEmbedder(key, model);
  _embedders.set(model, embedder);
  return embedder;
}

/** Convenience: returns a voyage-code-3 embedder optimised for code and structured text. */
export function getCodeEmbedder(): VoyageEmbedder | null {
  return getVoyageEmbedder('voyage-code-3');
}

/** Returns true for corpora whose chunks should be embedded with a code-optimised model. */
export function isCodeCorpus(corpus: Corpus): boolean {
  return CODE_CORPORA.has(corpus);
}

// Corpora that benefit from a code-aware embedding model.
// voyage-code-3 outperforms voyage-4-large on code retrieval while matching
// it on prose — so code/docs/spec all use it. The same 1024-dim HNSW index
// serves both models; namespace filtering provides semantic isolation.
const CODE_MODEL_CORPORA = new Set<Corpus>(['code', 'docs', 'spec']);

/**
 * Return the right VoyageEmbedder for a given corpus:
 * - code / docs / spec → voyage-code-3
 * - everything else → voyage-4-large
 *
 * Returns null when VOYAGE_API_KEY is not set (lexical-only fallback).
 */
export function getVoyageEmbedderForCorpus(corpus: Corpus): VoyageEmbedder | null {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  const model = CODE_MODEL_CORPORA.has(corpus) ? 'voyage-code-3' : DEFAULT_MODEL;
  return new VoyageEmbedder(key, model);
}
