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

// ── Entity types (Layer 2) ────────────────────────────────────────────────────

export type EntityKind =
  | 'file'
  | 'symbol'
  | 'heading'
  | 'pr'
  | 'task'
  | 'mission'
  | 'wikilink'
  | 'concept'
  | 'feature'
  | 'component';

export type EdgeType =
  | 'imports'
  | 'defines'
  | 'references'
  | 'produced'
  | 'implements'
  | 'supersedes'
  | 'references_doc'
  | 'relates_to'
  | 'outcome_of'
  | 'part_of';

/** Agent-supplied entity reference (loose name; resolved to canonical by the resolver). */
export interface EntityRef {
  kind: EntityKind;
  ref: string;
  role?: 'defines' | 'references' | 'mentions';
}

/** Agent-supplied directed relation between two loose entity refs. */
export interface RelationRef {
  from: string;
  type: EdgeType;
  to: string;
  weight?: number;
}

/** Resolver outcome returned to callers of resolveEntities(). */
export interface EntityBinding {
  bound: number;
  ambiguous: Array<{ ref: string; candidates: string[] }>;
  unresolved: string[];
}

export interface UpsertChunk {
  id: string;
  content: string;
  /** Text optimized for BM25/tsvector search. Defaults to content when absent. */
  lexicalText?: string;
  sourceType: string;
  sourcePath?: string | null;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown>;
  /** Layer 1: source event timestamp (commit time, completedAt, etc.). */
  sourceTs?: Date | null;
  /** Layer 2: entity refs to bind to this chunk at ingest time. */
  entities?: EntityRef[];
  /** Layer 2: directed relations to assert from this chunk. */
  relations?: RelationRef[];
  /** Layer 2: entity keys / source_ids this chunk supersedes. */
  supersedes?: string[];
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
