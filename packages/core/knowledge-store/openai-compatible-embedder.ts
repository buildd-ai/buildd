// An Embedder over any OpenAI-compatible `/embeddings` endpoint: OpenRouter,
// a hosted gateway, or a local server (TEI, vLLM, llama.cpp, Ollama) reached
// over a tunnel. Spec: docs/specs/pluggable-knowledge-store.md (section 7a).
//
// The store's column is a fixed vector(1024), so every vector is exactly 1024
// numbers or the call fails: fewer is refused, more is cut down (and
// re-normalised) only when the model is Matryoshka-trained.
//
// Failure is never a throw. An endpoint that is down, slow, misconfigured or
// returns the wrong shape makes `embed` return null, and the caller stores or
// searches lexical-only (the same contract as a spend-guard denial).

import type { Embedder, EmbedInputType } from './types';
import { estimateEmbedTokens, planEmbedRequests } from './voyage-embedder';
import { getVoyageGuard, type VoyageCall, type VoyageGuard } from './voyage-guard';

/** The width of knowledge_chunks.embedding. */
export const STORE_DIMENSIONS = 1024;

/** Inputs per request. Local servers commonly cap a batch at 32 (TEI's default). */
export const DEFAULT_ENDPOINT_MAX_BATCH = 32;
/** Estimated tokens per request (by the conservative 3-chars ratio). */
export const DEFAULT_ENDPOINT_MAX_TOKENS = 16_000;
/** A query embedding sits on the claim and recall path, so it gives up fast. */
export const DEFAULT_QUERY_TIMEOUT_MS = 5_000;
export const DEFAULT_DOCUMENT_TIMEOUT_MS = 30_000;

export interface OpenAICompatibleEmbedderOptions {
  baseUrl: string;
  model: string;
  /** Sent as `Authorization: Bearer`. Absent: no auth header (a local server). */
  apiKey?: string | null;
  /** Prepended to every query text (Qwen3-Embedding wants an instruction here). */
  queryPrefix?: string;
  /** Prepended to every document text. */
  docPrefix?: string;
  /** Truncate a longer vector to 1024 and L2-normalise it. Off: a longer vector is refused. */
  matryoshka?: boolean;
  /** Free endpoint: attributed as `unmetered`, not `endpoint`. */
  unmetered?: boolean;
  /** One timeout for both input types; absent, the per-type defaults above. */
  timeoutMs?: number | null;
  maxBatch?: number | null;
  maxTokensPerRequest?: number;
  guard?: VoyageGuard;
  fetch?: typeof fetch;
}

export class EmbeddingDimensionError extends Error {
  constructor(readonly model: string, readonly got: number, readonly matryoshka: boolean) {
    super(
      got < STORE_DIMENSIONS
        ? `Embedding model ${model} returned ${got} dimensions; the knowledge store needs ${STORE_DIMENSIONS}. ` +
          `Choose a model that outputs at least ${STORE_DIMENSIONS}. Nothing was stored with a vector.`
        : `Embedding model ${model} returned ${got} dimensions; the knowledge store needs ${STORE_DIMENSIONS}. ` +
          `Set EMBEDDING_MATRYOSHKA=true only if the model is Matryoshka-trained (its leading ${STORE_DIMENSIONS} ` +
          `dimensions are a valid embedding), or have the endpoint honour dimensions=${STORE_DIMENSIONS}. Nothing was stored with a vector.`,
    );
    this.name = 'EmbeddingDimensionError';
  }
}

/**
 * Fit one vector to the store's 1024 dimensions. Exactly 1024 passes through
 * unchanged; more is truncated and L2-normalised under Matryoshka, else refused;
 * fewer is always refused.
 */
export function fitToStoreDimensions(vector: number[], model: string, matryoshka: boolean): number[] {
  if (vector.length === STORE_DIMENSIONS) return vector;
  if (vector.length < STORE_DIMENSIONS || !matryoshka) {
    throw new EmbeddingDimensionError(model, vector.length, matryoshka);
  }
  const cut = vector.slice(0, STORE_DIMENSIONS);
  const norm = Math.sqrt(cut.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? cut.map(x => x / norm) : cut;
}

interface EmbeddingsResponse {
  data?: Array<{ embedding: number[]; index?: number }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/** Query vectors by endpoint, model and text, shared across corpora and callers (see voyage-embedder.ts). */
const QUERY_CACHE_MAX = 1_000;
const QUERY_CACHE_TTL_MS = 15 * 60 * 1000;
const queryCache = new Map<string, { at: number; vector: Promise<number[] | null> }>();

/** Drop every cached query embedding. Tests only. */
export function resetEndpointQueryCache(): void {
  queryCache.clear();
}

export class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions = STORE_DIMENSIONS;
  readonly provider = 'openai_compat' as const;
  private readonly url: string;
  private readonly opts: OpenAICompatibleEmbedderOptions;

  constructor(opts: OpenAICompatibleEmbedderOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.url = `${opts.baseUrl.replace(/\/+$/, '')}/embeddings`;
  }

  async embed(texts: string[], inputType: EmbedInputType, call: VoyageCall): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    return inputType === 'query' ? this.embedQueries(texts, call) : this.embedGuarded(texts, inputType, call);
  }

  private async embedQueries(texts: string[], call: VoyageCall): Promise<number[][] | null> {
    const now = Date.now();
    const key = (t: string) => `${this.url}\0${this.model}\0${this.opts.queryPrefix ?? ''}\0${t}`;
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
        const evict = () => { if (queryCache.get(k) === entry) queryCache.delete(k); };
        vector.then(v => { if (!v) evict(); }, evict);
      });
    }
    const vectors = await Promise.all(texts.map(t => queryCache.get(key(t))!.vector));
    return vectors.some(v => !v) ? null : (vectors as number[][]);
  }

  private async embedGuarded(texts: string[], inputType: EmbedInputType, call: VoyageCall): Promise<number[][] | null> {
    const prefix = (inputType === 'query' ? this.opts.queryPrefix : this.opts.docPrefix) ?? '';
    const inputs = prefix ? texts.map(t => prefix + t) : texts;
    const estimatedTokens = inputs.reduce((sum, t) => sum + estimateEmbedTokens(t), 0);

    let permit;
    try {
      permit = await (this.opts.guard ?? getVoyageGuard()).admit({
        ...call,
        kind: 'embed',
        model: this.model,
        inputType,
        estimatedTokens,
        provider: 'openai_compat',
        unmetered: !!this.opts.unmetered,
      });
    } catch (err) {
      console.warn('[embedding-endpoint] guard failed:', err);
      return null;
    }
    if (!permit) return null;

    const usage = { tokens: 0 };
    try {
      const out: number[][] = new Array(inputs.length);
      const plan = planEmbedRequests(
        inputs,
        this.opts.maxTokensPerRequest ?? DEFAULT_ENDPOINT_MAX_TOKENS,
        this.opts.maxBatch ?? DEFAULT_ENDPOINT_MAX_BATCH,
      );
      for (const indexes of plan) {
        const part = indexes.map(i => inputs[i]);
        const vectors = await this.request(part, inputType, usage);
        indexes.forEach((textIndex, j) => {
          out[textIndex] = vectors[j];
        });
      }
      return out;
    } catch (err) {
      if (err instanceof EmbeddingDimensionError) {
        // A configuration error, so loud; still not a throw into ingest.
        console.error(`[embedding-endpoint] ${err.message}`);
      } else {
        console.warn(`[embedding-endpoint] ${this.url} (${this.model}) failed; going lexical-only:`, err instanceof Error ? err.message : err);
      }
      return null;
    } finally {
      permit.settle(usage.tokens);
    }
  }

  private async request(texts: string[], inputType: EmbedInputType, usage: { tokens: number }): Promise<number[][]> {
    const timeoutMs = this.opts.timeoutMs
      ?? (inputType === 'query' ? DEFAULT_QUERY_TIMEOUT_MS : DEFAULT_DOCUMENT_TIMEOUT_MS);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    const res = await (this.opts.fetch ?? fetch)(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, input: texts, dimensions: STORE_DIMENSIONS }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`embedding endpoint error ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as EmbeddingsResponse;
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (rows.length !== texts.length) {
      throw new Error(`embedding endpoint returned ${rows.length} vectors for ${texts.length} inputs`);
    }
    // Billed tokens where the server reports them; else the estimate, so a
    // metered endpoint that omits usage is not recorded as free.
    const reported = data.usage?.total_tokens ?? data.usage?.prompt_tokens;
    usage.tokens += typeof reported === 'number' && reported > 0
      ? reported
      : texts.reduce((s, t) => s + estimateEmbedTokens(t), 0);
    const ordered = rows.every(r => typeof r.index === 'number')
      ? [...rows].sort((a, b) => (a.index as number) - (b.index as number))
      : rows;
    return ordered.map(r => {
      if (!Array.isArray(r.embedding)) throw new Error('embedding endpoint returned a non-array embedding');
      return fitToStoreDimensions(r.embedding, this.model, !!this.opts.matryoshka);
    });
  }
}
