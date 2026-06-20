import type { Embedder } from './types';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const DEFAULT_MODEL = 'voyage-code-3';
const DEFAULT_DIMENSIONS = 1024;

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

/**
 * Embedder backed by Voyage AI. Uses voyage-code-3 (1024 dims) which handles
 * both natural language and code well.
 *
 * Requires VOYAGE_API_KEY env var. Returns null from getVoyageEmbedder() when
 * the key is not present; callers should fall back to lexical-only mode.
 */
export class VoyageEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;

  constructor(
    private readonly apiKey: string,
    model = DEFAULT_MODEL,
    dimensions = DEFAULT_DIMENSIONS,
  ) {
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
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
        input_type: 'document',
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

let _embedder: VoyageEmbedder | null = null;

/** Return singleton VoyageEmbedder, or null if VOYAGE_API_KEY is not set. */
export function getVoyageEmbedder(): VoyageEmbedder | null {
  if (_embedder) return _embedder;
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  _embedder = new VoyageEmbedder(key);
  return _embedder;
}
