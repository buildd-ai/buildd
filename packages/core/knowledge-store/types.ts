// ── Embedder ─────────────────────────────────────────────────────────────────

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

// ── Reranker ─────────────────────────────────────────────────────────────────

/**
 * Cross-encoder reranker. Given a query and a candidate document set, returns
 * document indices with relevance scores in descending order. Optional in the
 * pipeline — when absent, RRF order stands.
 */
export interface Reranker {
  readonly model: string;
  rerank(
    query: string,
    documents: string[],
    topK?: number,
  ): Promise<Array<{ index: number; score: number }>>;
}

// ── Chunk types ───────────────────────────────────────────────────────────────

export type Corpus = 'memory' | 'code' | 'docs';
export type QueryMode = 'hybrid' | 'vector' | 'lexical';

export interface UpsertChunk {
  id: string;
  content: string;
  /** Text optimized for BM25/tsvector search. Defaults to content when absent. */
  lexicalText?: string;
  sourceType: string;
  sourcePath?: string | null;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface QueryResult {
  id: string;
  namespace: string;
  corpus: Corpus;
  sourceType: string;
  sourcePath: string | null;
  sourceUrl: string | null;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface QueryParams {
  text: string;
  filters?: {
    corpus?: Corpus;
    sourceType?: string;
  };
  mode?: QueryMode;
  topK?: number;
}

// ── KnowledgeStore interface ──────────────────────────────────────────────────

/**
 * Swappable store interface for semantic + lexical retrieval.
 * namespace = `${workspaceId}:${corpus}` (e.g. "ws-abc123:memory").
 * Phase 1 implements memory corpus only; code + docs come in Phase 2.
 * Phase 4 will add TurbopufferStore — new class, zero call-site changes.
 */
export interface KnowledgeStore {
  upsert(namespace: string, chunks: UpsertChunk[]): Promise<void>;
  query(namespace: string, params: QueryParams): Promise<QueryResult[]>;
  delete(namespace: string, ids: string[]): Promise<void>;
  listNamespaces(): Promise<string[]>;
  /**
   * Delete every chunk for a given source file (all `path#idx` chunks).
   * Used by code/docs ingestion to clean up before re-chunking a file, so a
   * file that shrank doesn't leave orphaned tail chunks. Optional — stores that
   * predate multi-chunk sources may omit it.
   */
  deleteBySource?(
    namespace: string,
    selector: { sourcePath?: string; sourceType?: string },
  ): Promise<void>;
}
