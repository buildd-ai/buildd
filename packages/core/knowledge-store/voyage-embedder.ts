import type { Embedder, EmbedInputType, Corpus } from './types';

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
 * Embedder backed by Voyage AI. Both voyage-4-large and voyage-code-3 output
 * 1024 dimensions, so the shared HNSW index requires no structural change.
 *
 * Supports asymmetric retrieval via `input_type`: pass `'query'` when embedding
 * search text and `'document'` (the default) when embedding stored chunks.
 *
 * Requires VOYAGE_API_KEY env var. Returns null from getVoyageEmbedder() when
 * the key is not present; callers should fall back to lexical-only mode.
 */
export class VoyageEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;

  constructor(
    private readonly apiKey: string,
    model: VoyageModel = DEFAULT_MODEL,
    dimensions = DEFAULT_DIMENSIONS,
  ) {
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[], inputType: EmbedInputType = 'document'): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: inputType,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Voyage AI embedding error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as VoyageResponse;
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
