import type { Reranker, QueryResult } from './types';
import { estimateRerankTokens } from '../voyage-budget';
import { getVoyageGuard, type VoyageCall, type VoyageGuard } from './voyage-guard';

const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';
const DEFAULT_MODEL = 'rerank-2.5';

/**
 * Voyage bills rerank as query tokens x documents + document tokens, so the query
 * is the expensive input: every character of it is paid once per candidate. The
 * head of a query (a task's title and opening) and of a chunk carry the signal.
 */
export const RERANK_MAX_QUERY_CHARS = 512;
export const RERANK_MAX_DOC_CHARS = 1024;

interface VoyageRerankResponse {
  data: Array<{ index: number; relevance_score: number }>;
  model: string;
  usage: { total_tokens: number };
}

/**
 * Cross-encoder reranker backed by Voyage AI (`rerank-2.5`). RRF gives a good
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
  private readonly guard: VoyageGuard | undefined;

  constructor(private readonly apiKey: string, model = DEFAULT_MODEL, opts: { guard?: VoyageGuard } = {}) {
    this.model = model;
    this.guard = opts.guard;
  }

  /** Scores by relevance, or null when the spend guard refuses (keep the order you have). */
  async rerank(
    query: string,
    documents: string[],
    topK: number | undefined,
    call: VoyageCall,
  ): Promise<Array<{ index: number; score: number }> | null> {
    if (documents.length === 0) return [];

    const sentQuery = query.slice(0, RERANK_MAX_QUERY_CHARS);
    const sentDocuments = documents.map(d => d.slice(0, RERANK_MAX_DOC_CHARS));
    const permit = await (this.guard ?? getVoyageGuard()).admit({
      ...call,
      kind: 'rerank',
      model: this.model,
      estimatedTokens: estimateRerankTokens(sentQuery, sentDocuments),
    });
    if (!permit) return null;

    let billed = 0;
    try {
      const res = await fetch(VOYAGE_RERANK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${permit.apiKey ?? this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          query: sentQuery,
          documents: sentDocuments,
          top_k: topK,
          return_documents: false,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Voyage AI rerank error ${res.status}: ${body}`);
      }

      const data = (await res.json()) as VoyageRerankResponse;
      billed = data.usage?.total_tokens ?? 0;
      return data.data.map(d => ({ index: d.index, score: d.relevance_score }));
    } finally {
      permit.settle(billed);
    }
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
 * be unit-tested and shared by every KnowledgeStore implementation. Null when the
 * reranker declined: the caller keeps its own order.
 */
export async function applyRerank(
  reranker: Reranker,
  query: string,
  candidates: QueryResult[],
  topK: number | undefined,
  call: VoyageCall,
): Promise<QueryResult[] | null> {
  if (candidates.length === 0) return candidates;

  const ranked = await reranker.rerank(query, candidates.map(c => c.content), topK, call);
  if (!ranked) return null;
  return ranked
    .filter(r => r.index >= 0 && r.index < candidates.length)
    .map(r => ({ ...candidates[r.index], score: r.score }));
}

/**
 * Does a hit clear a relevance floor? Floors are calibrated to reranker scores,
 * so a hit from a budget-denied path, which has none, is judged by nothing here:
 * applying the floor would empty every result the fallback exists to keep.
 */
export function clearsScoreFloor(hit: Pick<QueryResult, 'score' | 'scoreBreakdown'>, floor: number): boolean {
  return hit.scoreBreakdown?.budgetFallback === true || (hit.score ?? 0) >= floor;
}
