import type { Reranker, QueryResult } from './types';

const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';
const DEFAULT_MODEL = 'rerank-2';

interface VoyageRerankResponse {
  data: Array<{ index: number; relevance_score: number }>;
  model: string;
  usage: { total_tokens: number };
}

/**
 * Cross-encoder reranker backed by Voyage AI (`rerank-2`). RRF gives a good
 * candidate set from two cheap signals; a reranker scores each candidate
 * against the full query text and is the single biggest precision win for the
 * top few results. Injectable via the `Reranker` interface so it can be swapped
 * or mocked.
 *
 * Requires VOYAGE_API_KEY. `getVoyageReranker()` returns null when absent;
 * callers should skip reranking (RRF order stands).
 */
export class VoyageReranker implements Reranker {
  readonly model: string;

  constructor(private readonly apiKey: string, model = DEFAULT_MODEL) {
    this.model = model;
  }

  async rerank(
    query: string,
    documents: string[],
    topK?: number,
  ): Promise<Array<{ index: number; score: number }>> {
    if (documents.length === 0) return [];

    const res = await fetch(VOYAGE_RERANK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        top_k: topK,
        return_documents: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Voyage AI rerank error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as VoyageRerankResponse;
    return data.data.map(d => ({ index: d.index, score: d.relevance_score }));
  }
}

let _reranker: VoyageReranker | null = null;

/** Return singleton VoyageReranker, or null if VOYAGE_API_KEY is not set. */
export function getVoyageReranker(): VoyageReranker | null {
  if (_reranker) return _reranker;
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  _reranker = new VoyageReranker(key);
  return _reranker;
}

/**
 * Reorder query results by a reranker's relevance scores, rewriting `score`
 * to the reranker's value. Pure (no I/O beyond the injected reranker) so it can
 * be unit-tested and shared by every KnowledgeStore implementation.
 */
export async function applyRerank(
  reranker: Reranker,
  query: string,
  candidates: QueryResult[],
  topK?: number,
): Promise<QueryResult[]> {
  if (candidates.length === 0) return candidates;

  const ranked = await reranker.rerank(query, candidates.map(c => c.content), topK);
  return ranked
    .filter(r => r.index >= 0 && r.index < candidates.length)
    .map(r => ({ ...candidates[r.index], score: r.score }));
}
