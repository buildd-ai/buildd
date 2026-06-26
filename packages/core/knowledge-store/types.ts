// ── Embedder ─────────────────────────────────────────────────────────────────

/**
 * Asymmetric retrieval input type. Voyage embeds documents and queries with
 * different prefixes; using `'query'` for the search text and `'document'` for
 * stored chunks is a real recall win. Defaults to `'document'`.
 */
export type EmbedInputType = 'document' | 'query';

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], inputType?: EmbedInputType): Promise<number[][]>;
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

export type Corpus =
  | 'memory'
  | 'code'
  | 'docs'
  | 'spec'
  | 'task'
  | 'artifact'
  | 'pr'
  | 'plan'
  | 'session';
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
  /** When the source event occurred (commit time, task completion, memory update, etc.). */
  sourceTs?: Date | null;
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
  /** Source event timestamp, when available. Used for recency scoring. */
  sourceTs?: Date | null;
}

export interface QueryParams {
  text: string;
  filters?: {
    corpus?: Corpus;
    sourceType?: string;
  };
  mode?: QueryMode;
  topK?: number;
  /**
   * When true, apply recency × authority multipliers to final scores.
   * Defaults to the ENABLE_RECENCY_AUTHORITY env var (default: enabled).
   */
  useRecencyAuthority?: boolean;
  /**
   * When true, include superseded chunks (is_current = false) in results.
   * Off by default — only relevant for historical queries.
   */
  history?: boolean;
  /**
   * Optional instruction prepended to the reranker query for rerank-2.5.
   * The reranker is instruction-following; use this for soft priority hints
   * (e.g. "prefer current specifications over historical task outcomes").
   * Recency/authority/supersession are always applied deterministically.
   */
  rerankInstruction?: string;
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
