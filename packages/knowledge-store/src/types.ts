// ── Database handle ──────────────────────────────────────────────────────────

/**
 * Minimal structural type for the database handle PgVectorStore needs.
 * Any Drizzle instance backed by `@neondatabase/serverless` satisfies this —
 * the store issues raw `sql` and reads results off `.rows`. Injecting the
 * handle (rather than importing a specific app's db module) is what lets buildd,
 * the memory service, and cue each run the same engine against their own DB.
 */
export interface KnowledgeDb {
  execute(query: unknown): Promise<{ rows: Record<string, unknown>[] }>;
}

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
  | 'session'
  | 'email';
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
  /** When the source event occurred (commit time, task completion time, etc.). Phase 1+. */
  sourceTs?: Date | null;
  /** Agent-supplied entity refs for this chunk. Phase 2+. */
  entities?: EntityRef[];
  /** Agent-supplied directed relations. Phase 2+. */
  relations?: RelationRef[];
  /** Entity keys or source_ids this chunk supersedes. Phase 2+. */
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
  /** Graph proximity boost (1.0 for seed chunks, ≤1.0 for expanded neighbors). Phase 3+. */
  graphProximity?: number;
}

export interface QueryParams {
  text: string;
  filters?: {
    corpus?: Corpus;
    sourceType?: string;
  };
  mode?: QueryMode;
  topK?: number;
  /** Enable 1-hop graph expansion (Phase 3). Default true. */
  useGraph?: boolean;
  /** Include superseded (is_current=false) chunks. Default false. */
  history?: boolean;
  /**
   * Apply the built-in corpus-authority x recency decay. Default true.
   *
   * As of 0.2.0 this is applied *after* rerank, so it affects the returned
   * ordering in both regimes. Previously it ran before `applyRerank`, which
   * overwrites `score` — so the term was the entire ranking without a reranker
   * and was silently discarded with one.
   *
   * Pass false when the caller owns age and authority policy itself; the store
   * then returns retrieval relevance only, and nothing double-penalises age.
   */
  recencyAuthority?: boolean;
}

// ── KnowledgeStore interface ──────────────────────────────────────────────────

/**
 * Swappable store interface for semantic + lexical retrieval.
 * namespace = `${workspaceId}:${corpus}` (e.g. "ws-abc123:memory").
 */
export interface KnowledgeStore {
  upsert(namespace: string, chunks: UpsertChunk[]): Promise<void>;
  query(namespace: string, params: QueryParams): Promise<QueryResult[]>;
  delete(namespace: string, ids: string[]): Promise<void>;
  listNamespaces(): Promise<string[]>;
  /**
   * Delete every chunk for a given source file (all `path#idx` chunks).
   * Used by code/docs ingestion to clean up before re-chunking a file, so a
   * file that shrank doesn't leave orphaned tail chunks.
   */
  deleteBySource?(
    namespace: string,
    selector: { sourcePath?: string; sourceType?: string },
  ): Promise<void>;
}

// ── Entity / Relation types (Phase 2+) ────────────────────────────────────────

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

export interface EntityRef {
  kind: EntityKind;
  /** Loose name the agent wrote; resolver binds to canonical. */
  ref: string;
  role?: 'defines' | 'references' | 'mentions';
}

export type RelationType =
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

export interface RelationRef {
  from: string;
  type: RelationType;
  to: string;
  weight?: number;
}

// ── Edge builder types (Phase 3) ─────────────────────────────────────────────

export interface EntityUpsert {
  workspaceId: string;
  kind: EntityKind;
  key: string;
  canonicalName: string;
  attributes?: Record<string, unknown>;
}

export interface EdgeUpsert {
  workspaceId: string;
  fromEntityKey: string;
  fromEntityKind: EntityKind;
  toEntityKey: string;
  toEntityKind: EntityKind;
  type: RelationType;
  weight: number;
  sourceChunkId?: string;
  rule: string;
}

export interface PendingRef {
  workspaceId: string;
  rawRef: string;
  kindHint?: EntityKind;
  sourceChunkId?: string;
  source: 'agent' | 'ingest';
}

export interface EntityBinding {
  bound: number;
  ambiguous: Array<{ ref: string; candidates: string[] }>;
  unresolved: string[];
}
