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
  /** When the source event occurred (commit time, task completion time, etc.). Phase 1+. */
  sourceTs?: Date | null;
  /** Agent-supplied entity refs for this chunk. Phase 2+. */
  entities?: EntityRef[];
  /** Agent-supplied directed relations. Phase 2+. */
  relations?: RelationRef[];
  /** Entity keys or source_ids this chunk supersedes. Phase 2+. */
  supersedes?: string[];
}

/** Result of an upsert batch. Superseded counts explicit-supersession matches. */
export interface UpsertResult {
  /** Rows marked is_current=false via `UpsertChunk.supersedes` across the batch. */
  superseded: number;
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
   * Record retrieval hits (hit_count/last_hit_at) on returned chunks — a
   * fire-and-forget UPDATE that never blocks or fails the query. Default true;
   * pass false for eval/assessment runs so they don't pollute hit stats.
   */
  trackHits?: boolean;
}

// ── KnowledgeStore interface ──────────────────────────────────────────────────

/**
 * Swappable store interface for semantic + lexical retrieval.
 * namespace = `${workspaceId}:${corpus}` (e.g. "ws-abc123:memory").
 */
export interface KnowledgeStore {
  /**
   * Upsert chunks. May return an UpsertResult (explicit-supersession count);
   * simple implementations can keep returning void.
   */
  upsert(namespace: string, chunks: UpsertChunk[]): Promise<UpsertResult | void>;
  query(namespace: string, params: QueryParams): Promise<QueryResult[]>;
  delete(namespace: string, ids: string[]): Promise<void>;
  listNamespaces(): Promise<string[]>;
  /**
   * Entity-keyed supersession (optional). Mark other `is_current` chunks in the
   * namespace whose `role='defines'` entity set is IDENTICAL to `entityIds`,
   * whose source_ts is older than the new chunk's, and whose corpus authority
   * is ≤ the new chunk's, as superseded by `newSourceId`. Returns the number of
   * chunks marked.
   */
  markSupersededByEntities?(
    namespace: string,
    newSourceId: string,
    entityIds: string[],
    opts?: { corpus?: Corpus; sourceTs?: Date | null },
  ): Promise<number>;
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
  /**
   * Junction role for the chunk↔entity link (chunk_entities.role).
   * Defaults to 'mentions'; symbol entities extracted from their defining
   * chunk carry 'defines'.
   */
  role?: 'defines' | 'references' | 'mentions';
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
