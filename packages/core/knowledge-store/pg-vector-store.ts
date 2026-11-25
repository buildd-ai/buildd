import { sql } from 'drizzle-orm';
import type { KnowledgeStore, UpsertChunk, UpsertResult, QueryResult, QueryParams, Embedder, Reranker, Corpus, ReusableEmbeddings } from './types';
import { applyRerank } from './reranker';
import { getEmbedderForCorpus, resolveEmbeddingConfig, type EmbeddingConfig } from './embedding-config';
import { markReembed, resolveNamespaceSpace, type NamespaceSpace } from './namespace-space';
import { vectorColumnForDimensions, type VectorColumn } from '@buildd/shared';
import type { VoyageCall } from './voyage-guard';
import { applyRecencyAuthority, CORPUS_AUTHORITY } from './recency-authority';
import { LIVING_SPEC_DRAFT_SOURCE_TYPE } from './living-spec';
import { createHash } from 'crypto';

// Lazy DB import — avoids hitting DATABASE_URL during build/test
async function getDb() {
  const { db } = await import('../db/index');
  return db;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function buildNamespace(workspaceId: string, corpus: Corpus): string {
  return `${workspaceId}:${corpus}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function vectorToString(v: number[]): string {
  return `[${v.join(',')}]`;
}

// The vector column per supported size (docs/specs/local-runner-provider.md
// §5.2): fixed identifiers, never interpolated from input. `embedding` is the
// 1024 column every Voyage query always used, so that SQL is unchanged (AC-18).
const COLUMN_SQL: Readonly<Record<VectorColumn, ReturnType<typeof sql>>> = {
  embedding: sql`embedding`,
  embedding_768: sql`embedding_768`,
  embedding_1536: sql`embedding_1536`,
};
const ALL_VECTOR_COLUMNS: readonly VectorColumn[] = ['embedding', 'embedding_768', 'embedding_1536'];

/** `other = NULL, …` for every vector column but `keep`: a row holds one vector (the CHECK). */
function nullOtherColumns(keep: VectorColumn): ReturnType<typeof sql> {
  return sql.join(ALL_VECTOR_COLUMNS.filter(c => c !== keep).map(c => sql`${COLUMN_SQL[c]} = NULL`), sql`, `);
}

/** The space a namespace touch resolved to: which embedder may run its vector leg, and on which column. */
interface ResolvedSpace {
  /** The embedder for the vector legs; null when there is nothing comparable to search or store (lexical-only). */
  embedder: Embedder | null;
  column: VectorColumn;
  space: NamespaceSpace | null;
  /** Set when an embedder was configured but may not write vectors here: the reason, for the caller's warning. */
  refused: 'unsupported_dimensions' | 'dimension_mismatch' | null;
}

const warnedNamespaces = new Set<string>();
const WARNED_MAX = 2_000;
function warnOnce(key: string, message: string): void {
  if (warnedNamespaces.has(key)) return;
  if (warnedNamespaces.size >= WARNED_MAX) warnedNamespaces.clear();
  warnedNamespaces.add(key);
  console.warn(message);
}

// ── NUL-byte sanitization ────────────────────────────────────────────────────
//
// Postgres text columns reject literal NUL (0x00) bytes with
// `invalid byte sequence for encoding "UTF8"`. A file misclassified as text
// (or any other artifact upstream in the ingest pipeline — file walker,
// chunker, decoding) can smuggle a stray NUL byte into content that otherwise
// looks like ordinary text. We can't guarantee every upstream producer is
// clean, so strip defensively right before insert instead.

const NUL_BYTE = String.fromCharCode(0);

/** Remove literal NUL bytes from a string. Returns the same reference when none are present. */
export function stripNulBytes(value: string): string {
  return value.indexOf(NUL_BYTE) === -1 ? value : value.split(NUL_BYTE).join('');
}

interface SanitizedChunkText {
  sourceId: string;
  sourceType: string;
  sourcePath: string | null;
  sourceUrl: string | null;
  content: string;
  lexicalText: string;
}

/**
 * Sanitize every text field of a chunk that gets written to `knowledge_chunks`.
 * Strips NUL bytes and logs a warning (without throwing) when any were found,
 * so a single bad byte doesn't crash the whole ingest batch but is still
 * visible in ingest output.
 */
export function sanitizeChunkForInsert(chunk: UpsertChunk, lexicalText: string): SanitizedChunkText {
  const sanitized: SanitizedChunkText = {
    sourceId: stripNulBytes(chunk.id),
    sourceType: stripNulBytes(chunk.sourceType),
    sourcePath: chunk.sourcePath != null ? stripNulBytes(chunk.sourcePath) : null,
    sourceUrl: chunk.sourceUrl != null ? stripNulBytes(chunk.sourceUrl) : null,
    content: stripNulBytes(chunk.content),
    lexicalText: stripNulBytes(lexicalText),
  };

  const changed =
    sanitized.sourceId !== chunk.id ||
    sanitized.sourceType !== chunk.sourceType ||
    sanitized.sourcePath !== (chunk.sourcePath ?? null) ||
    sanitized.sourceUrl !== (chunk.sourceUrl ?? null) ||
    sanitized.content !== chunk.content ||
    sanitized.lexicalText !== lexicalText;

  if (changed) {
    console.warn(
      `[knowledge-store] stripped NUL byte(s) from chunk "${chunk.id}" ` +
        `(source: ${chunk.sourcePath ?? 'unknown'}) before insert`,
    );
  }

  return sanitized;
}

/**
 * Build the lexical (full-text) search query. Ranks against the stored
 * generated `lexical_tsv` column rather than recomputing
 * `to_tsvector('english', coalesce(lexical_text, content))` for every row —
 * that recomputation was the slowest query on the claim path in prod traces.
 * The column's generation expression must stay identical to this comment's.
 */
export function buildLexicalSearchSql(
  namespace: string,
  text: string,
  filterClause: ReturnType<typeof sql>,
  currentClause: ReturnType<typeof sql>,
  limit: number,
) {
  return sql`
    SELECT source_id AS id,
           ts_rank(lexical_tsv, websearch_to_tsquery('english', ${text})) AS score
    FROM knowledge_chunks
    WHERE namespace = ${namespace}
      AND lexical_tsv @@ websearch_to_tsquery('english', ${text})
      ${filterClause}
      ${currentClause}
    ORDER BY score DESC
    LIMIT ${limit}
  `;
}

/**
 * Reciprocal Rank Fusion — fuse vector ANN and lexical BM25 result lists.
 * k=60 is the standard constant from the original RRF paper.
 */
export function reciprocalRankFusion(
  vectorResults: Array<{ id: string; score: number }>,
  lexicalResults: Array<{ id: string; score: number }>,
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();

  vectorResults.forEach(({ id }, idx) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
  });
  lexicalResults.forEach(({ id }, idx) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
  });

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// ── Row shape returned by raw SQL queries ────────────────────────────────────

interface ChunkRow {
  id: string;
  source_id: string;
  namespace: string;
  corpus: Corpus;
  source_type: string;
  source_path: string | null;
  source_url: string | null;
  content: string;
  metadata: Record<string, unknown>;
  source_ts?: string | null;
  updated_at?: string | null;
  is_current?: boolean;
  superseded_by?: string | null;
  score?: number;
}

// ── Graph expansion helper types ──────────────────────────────────────────────

interface EntityRow {
  entity_id: string;
}

interface EdgeRow {
  to_entity_id: string;
  weight: string;
}

interface EntityChunkRow {
  source_id: string;
  namespace: string;
  corpus: Corpus;
  source_type: string;
  source_path: string | null;
  source_url: string | null;
  content: string;
  metadata: Record<string, unknown>;
  source_ts?: string | null;
}

// ── PgVectorStore ────────────────────────────────────────────────────────────

/** Most candidates one rerank call may score. Each is billed with the query again. */
export const RERANK_CANDIDATE_CAP = 20;

export class PgVectorStore implements KnowledgeStore {
  private readonly caller: string;
  private readonly embeddingConfig: (ownerId: string) => Promise<EmbeddingConfig>;

  /**
   * `opts.caller` names this store's spend in attribution (see ./voyage-guard.ts).
   * `opts.embeddingConfig` resolves a namespace owner's provider (default: env
   * or the provider its team picked for embeddings, see ./embedding-config.ts).
   */
  constructor(
    private readonly embedder: Embedder | null,
    private readonly reranker: Reranker | null = null,
    opts: { caller?: string; embeddingConfig?: (ownerId: string) => Promise<EmbeddingConfig> } = {},
  ) {
    this.caller = opts.caller ?? 'unattributed';
    this.embeddingConfig = opts.embeddingConfig ?? (ownerId => resolveEmbeddingConfig(ownerId));
  }

  /**
   * The one embedder a namespace writes and queries with. Under the default
   * (Voyage) config this is the store's own embedder, or voyage-code-3 for
   * code/docs/spec, exactly as before.
   */
  private async _selectEmbedder(namespace: string): Promise<Embedder | null> {
    const [owner = '', corpus] = namespace.split(':');
    return getEmbedderForCorpus(corpus as Corpus, await this.embeddingConfig(owner), this.embedder);
  }

  /** The model a namespace embeds with when its team picked a provider; null on the default. */
  private async _pickedModel(namespace: string): Promise<string | null> {
    const [owner = '', corpus] = namespace.split(':');
    const cfg = await this.embeddingConfig(owner);
    if (cfg.source !== 'team') return null;
    return getEmbedderForCorpus(corpus as Corpus, cfg, this.embedder)?.model ?? null;
  }

  /**
   * The namespace's embedding space for this touch (spec §5.3, D-1..D-5): the
   * embedder's column, with the namespace row created or moved as needed. An
   * embedder whose size has no column, or whose space the row could not be
   * brought to, gets no vector leg: the touch runs lexical-only and nothing of
   * another size is ever stored or compared (D-4).
   */
  private async _space(db: Awaited<ReturnType<typeof getDb>>, namespace: string, embedder: Embedder | null): Promise<ResolvedSpace> {
    if (!embedder) return { embedder: null, column: 'embedding', space: null, refused: null };
    const [owner = ''] = namespace.split(':');
    const cfg = await this.embeddingConfig(owner);
    const provider = cfg.source === 'team' ? (cfg.provider === 'openai_compat' ? 'endpoint' : cfg.provider) : cfg.provider;
    const res = await resolveNamespaceSpace(namespace, { model: embedder.model, dimensions: embedder.dimensions, provider }, q => db.execute(q));
    if (res.kind === 'ok') return { embedder, column: res.space.vectorColumn, space: res.space, refused: null };
    if (res.kind === 'unsupported') {
      warnOnce(`${namespace}:unsupported`, `[knowledge-store] ${embedder.model} returns ${res.dimensions} dimensions; knowledge_chunks has no column for that size, so ${namespace} runs lexical-only`);
      return { embedder: null, column: res.space?.vectorColumn ?? 'embedding', space: res.space, refused: 'unsupported_dimensions' };
    }
    warnOnce(`${namespace}:mismatch`, `[knowledge-store] dimension_mismatch: ${namespace} is stored at (${res.space.model}, ${res.space.dimensions}) but ${embedder.model} embeds at ${embedder.dimensions}; the vector leg is skipped`);
    return { embedder: null, column: res.space.vectorColumn, space: res.space, refused: 'dimension_mismatch' };
  }

  async findReusableEmbeddings(namespace: string, chunks: UpsertChunk[]): Promise<ReusableEmbeddings> {
    const out = new Map<string, string>();
    const selected = await this._selectEmbedder(namespace);
    if (!selected || chunks.length === 0) return out;
    const db = await getDb();
    const { embedder, column } = await this._space(db, namespace, selected);
    if (!embedder) return out;
    const col = COLUMN_SQL[column];
    const hashes = [...new Set(chunks.map(c => sha256(stripNulBytes(c.content))))];
    const res = await db.execute(sql`
      SELECT coalesce(lexical_text, content) AS text, ${col}::text AS embedding
      FROM knowledge_chunks
      WHERE namespace = ${namespace}
        AND content_hash IN (${sql.join(hashes.map(h => sql`${h}`), sql`, `)})
        AND embedding_model = ${embedder.model}
        AND ${col} IS NOT NULL
    `);
    for (const row of (res?.rows ?? []) as Array<{ text: string; embedding: string }>) out.set(row.text, row.embedding);
    return out;
  }

  async upsert(namespace: string, chunks: UpsertChunk[], opts: { reuse?: ReusableEmbeddings } = {}): Promise<UpsertResult> {
    if (chunks.length === 0) return { superseded: 0 };

    let superseded = 0;
    let lexicalOnly = 0;
    const db = await getDb();
    const corpus = namespace.split(':')[1] as Corpus;
    // A refused space (no column for the size, or a concurrent move) stores
    // rows without a vector AND without a file hash, like a guard refusal, so
    // the next ingest tries them again (AC-14, AC-24).
    const resolved = await this._space(db, namespace, await this._selectEmbedder(namespace));
    const activeEmbedder = resolved.embedder;
    const col = COLUMN_SQL[resolved.column];
    const refused = resolved.refused !== null;

    // Content-hash dedup: drop a chunk whose identical content already exists in
    // the namespace under a DIFFERENT source_id. This prevents cross-PR
    // near-duplicates where the same file diff appears in multiple rebased PRs
    // (e.g. a design doc added in PR #1604 that also shows as @@ -0,0 +1,348 @@ in
    // PRs #1608 and #1609). The content_hash_idx on (namespace, content_hash)
    // makes the lookup fast. Before embedding: a dropped chunk costs nothing.
    const kept: UpsertChunk[] = [];
    for (const chunk of chunks) {
      if (chunk.contentDedup) {
        const existingRows = await db.execute(sql`
          SELECT source_id FROM knowledge_chunks
          WHERE namespace = ${namespace}
            AND content_hash = ${sha256(stripNulBytes(chunk.content))}
            AND source_id != ${stripNulBytes(chunk.id)}
          LIMIT 1
        `);
        if ((existingRows.rows as Array<{ source_id: string }>).length > 0) continue;
      }
      kept.push(chunk);
    }
    if (kept.length === 0) return { superseded: 0 };

    // Embed only what no stored row already holds a vector for.
    const textOf = (c: UpsertChunk) => stripNulBytes(c.lexicalText ?? c.content);
    const reuse = opts.reuse ?? await this.findReusableEmbeddings(namespace, kept);
    const toEmbed = activeEmbedder ? [...new Set(kept.map(textOf).filter(t => !reuse.has(t)))] : [];
    const fresh = toEmbed.length > 0
      ? await activeEmbedder!.embed(toEmbed, 'document', { namespace, caller: this.caller })
      : [];
    const denied = fresh === null || refused;
    const vectors = new Map<string, string>(reuse);
    toEmbed.forEach((t, i) => { if (fresh?.[i]) vectors.set(t, vectorToString(fresh[i])); });

    for (const chunk of kept) {
      const embedding = vectors.get(textOf(chunk)) ?? null;
      const rawLexicalText = chunk.lexicalText ?? chunk.content;
      // Defensively strip any stray NUL bytes before they hit the INSERT —
      // Postgres text columns reject 0x00 outright (see stripNulBytes above).
      const clean = sanitizeChunkForInsert(chunk, rawLexicalText);
      const contentHash = sha256(clean.content);
      // A chunk the guard refused must not look finished: with its file hash
      // stored, the next ingest would skip the file and it would never get a vector.
      const unembedded = denied && !embedding;
      if (unembedded) lexicalOnly++;
      const fileHash = unembedded ? null : chunk.fileHash ?? null;
      const sourceTs = chunk.sourceTs ?? null;

      // Write source_ts into metadata so recency scoring can read it on query
      const metadataWithTs = {
        ...(chunk.metadata ?? {}),
        ...(sourceTs ? { source_ts: sourceTs.toISOString() } : {}),
      };

      if (embedding) {
        // The vector goes into the namespace's column; the other size columns
        // are cleared so a row re-embedded at a new size never keeps the old
        // vector beside it (D-3, the CHECK).
        await db.execute(sql`
          INSERT INTO knowledge_chunks
            (source_id, namespace, corpus, source_type, source_path, source_url,
             content, lexical_text, ${col}, embedding_model, metadata, content_hash,
             file_hash, source_ts, updated_at)
          VALUES
            (${clean.sourceId}, ${namespace}, ${corpus}, ${clean.sourceType},
             ${clean.sourcePath}, ${clean.sourceUrl},
             ${clean.content}, ${clean.lexicalText},
             ${embedding}::vector,
             ${activeEmbedder!.model},
             ${JSON.stringify(metadataWithTs)}::jsonb,
             ${contentHash},
             ${fileHash},
             ${sourceTs ? sourceTs.toISOString() : null},
             NOW())
          ON CONFLICT (namespace, source_id) DO UPDATE SET
            content         = EXCLUDED.content,
            lexical_text    = EXCLUDED.lexical_text,
            ${col}       = EXCLUDED.${col},
            ${nullOtherColumns(resolved.column)},
            embedding_model = EXCLUDED.embedding_model,
            metadata        = EXCLUDED.metadata,
            content_hash    = EXCLUDED.content_hash,
            file_hash       = EXCLUDED.file_hash,
            source_path     = EXCLUDED.source_path,
            source_url      = EXCLUDED.source_url,
            source_ts       = EXCLUDED.source_ts,
            updated_at      = NOW()
        `);
      } else {
        await db.execute(sql`
          INSERT INTO knowledge_chunks
            (source_id, namespace, corpus, source_type, source_path, source_url,
             content, lexical_text, metadata, content_hash, file_hash, source_ts, updated_at)
          VALUES
            (${clean.sourceId}, ${namespace}, ${corpus}, ${clean.sourceType},
             ${clean.sourcePath}, ${clean.sourceUrl},
             ${clean.content}, ${clean.lexicalText},
             ${JSON.stringify(metadataWithTs)}::jsonb,
             ${contentHash},
             ${fileHash},
             ${sourceTs ? sourceTs.toISOString() : null},
             NOW())
          ON CONFLICT (namespace, source_id) DO UPDATE SET
            -- New text with no new vector: the old vector describes text that is gone.
            embedding = CASE WHEN knowledge_chunks.content_hash = EXCLUDED.content_hash
                             THEN knowledge_chunks.embedding END,
            embedding_768 = CASE WHEN knowledge_chunks.content_hash = EXCLUDED.content_hash
                             THEN knowledge_chunks.embedding_768 END,
            embedding_1536 = CASE WHEN knowledge_chunks.content_hash = EXCLUDED.content_hash
                             THEN knowledge_chunks.embedding_1536 END,
            embedding_model = CASE WHEN knowledge_chunks.content_hash = EXCLUDED.content_hash
                                   THEN knowledge_chunks.embedding_model END,
            content      = EXCLUDED.content,
            lexical_text = EXCLUDED.lexical_text,
            metadata     = EXCLUDED.metadata,
            content_hash = EXCLUDED.content_hash,
            file_hash    = EXCLUDED.file_hash,
            source_path  = EXCLUDED.source_path,
            source_url   = EXCLUDED.source_url,
            source_ts    = EXCLUDED.source_ts,
            updated_at   = NOW()
        `);
      }

      // Phase 1: supersession — mark older same-path chunks as not current
      if (clean.sourcePath && sourceTs) {
        await this._markSuperseded(db, namespace, clean.sourceId, clean.sourcePath, sourceTs);
      }

      // Wave-1 C1: explicit supersession — the agent asserted this chunk
      // replaces specific earlier chunks (same namespace only; self-references
      // skipped; ids that don't match any current row are silently ignored).
      const explicitTargets = (chunk.supersedes ?? []).filter(s => s && s !== chunk.id);
      if (explicitTargets.length > 0) {
        superseded += await this._markSupersededExplicit(db, namespace, clean.sourceId, explicitTargets);
      }
    }

    return { superseded, ...(lexicalOnly > 0 ? { lexicalOnly } : {}) };
  }

  async query(namespace: string, params: QueryParams): Promise<QueryResult[]> {
    const { text, mode = 'hybrid', topK = 10, filters, useGraph = true, history = false, trackHits = true, recencyAuthority = true } = params;
    const db = await getDb();
    // Vectors from another model are not comparable: the vector legs only see
    // rows embedded by the query's model (others still reach results lexically).
    // Nor is another size (D-2): a query embedder whose size is not the
    // namespace's never runs against the index; the query is lexical-only.
    const resolved = await this._space(db, namespace, await this._selectEmbedder(namespace));
    const activeEmbedder = resolved.embedder;
    const queryModel = activeEmbedder?.model ?? null;
    // A caller-supplied vector with no embedder: the column its size names.
    const column: VectorColumn = activeEmbedder
      ? resolved.column
      : (params.embedding?.length ? vectorColumnForDimensions(params.embedding.length) : null) ?? resolved.column;
    const limit = Math.min(topK, 50);
    const candidateLimit = this.reranker ? Math.min(limit * 3, RERANK_CANDIDATE_CAP) : limit;
    const call = { namespace, caller: params.caller ?? this.caller };
    // Set when the guard refuses the query embedding or the rerank.
    const budget = { denied: false };

    const typeClause = filters?.corpus
      ? sql`AND corpus = ${filters.corpus}`
      : filters?.sourceType
      ? sql`AND source_type = ${filters.sourceType}`
      : sql``;
    // Draft Living Specs only when asked (R-106); a caller's own chunks never.
    const draftClause = params.includeDrafts ? sql`` : sql`AND source_type <> ${LIVING_SPEC_DRAFT_SOURCE_TYPE}`;
    const excluded = (params.excludeSourceIdPrefixes ?? []).filter(Boolean);
    const excludeClause = excluded.length
      ? sql.join(excluded.map(p => sql`AND NOT starts_with(source_id, ${p})`), sql` `)
      : sql``;
    const filterClause = sql`${typeClause} ${draftClause} ${excludeClause}`;

    // Phase 1: filter superseded chunks (unless history mode)
    const currentClause = history ? sql`` : sql`AND is_current = true`;

    let results: QueryResult[];

    const embeddingStr = mode === 'vector' || mode === 'hybrid'
      ? await this._queryEmbedding(db, namespace, params, activeEmbedder, column, call, budget)
      : null;

    if (mode === 'vector' && !embeddingStr) return [];
    if (embeddingStr) {
      if (mode === 'vector') {
        const vectorRanked = await this._vectorSearch(db, namespace, embeddingStr, filterClause, currentClause, limit * 2, queryModel, column);
        const ids = vectorRanked.slice(0, candidateLimit).map(r => r.id);
        if (ids.length === 0) return [];
        const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause, currentClause);
        const scoreMap = new Map(vectorRanked.map(r => [r.id, r.score]));
        const breakdownMap = new Map(vectorRanked.map(r => [r.id, { dense: r.score }]));
        results = this._toResults(rows, scoreMap, ids, breakdownMap);
      } else {
        // Vector ANN and lexical rank are independent reads — issue both
        // concurrently instead of paying their latencies back-to-back.
        const [vectorRanked, lexicalRes] = await Promise.all([
          this._vectorSearch(db, namespace, embeddingStr, filterClause, currentClause, limit * 2, queryModel, column),
          db.execute(buildLexicalSearchSql(namespace, text, filterClause, currentClause, limit * 2)),
        ]);

        const lexicalRanked = (lexicalRes.rows as Array<{ id: string; score: number }>)
          .map(r => ({ id: r.id, score: Number(r.score) }));

        const fused = reciprocalRankFusion(vectorRanked, lexicalRanked).slice(0, candidateLimit);
        const rrfScores = new Map(fused.map(r => [r.id, r.score]));

        const denseMap = new Map(vectorRanked.map(r => [r.id, r.score]));
        const lexMap = new Map(lexicalRanked.map(r => [r.id, r.score]));
        const breakdownMap = new Map<string, QueryResult['scoreBreakdown']>(
          fused.map(r => [r.id, { dense: denseMap.get(r.id), lexical: lexMap.get(r.id) }]),
        );

        const ids = fused.map(r => r.id);
        if (ids.length === 0) return [];
        const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause, currentClause);
        results = this._toResults(rows, rrfScores, ids, breakdownMap);
      }
    } else {
      // Lexical-only
      const lexOnlyRes = await db.execute(buildLexicalSearchSql(namespace, text, filterClause, currentClause, candidateLimit));

      const lexRanked = (lexOnlyRes.rows as Array<{ id: string; score: number }>)
        .map(r => ({ id: r.id, score: Number(r.score) }));

      if (lexRanked.length === 0) return [];
      const ids = lexRanked.map(r => r.id);
      const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause, currentClause);
      const scoreMap = new Map(lexRanked.map(r => [r.id, r.score]));
      const breakdownMap = new Map(lexRanked.map(r => [r.id, { lexical: r.score }]));
      results = this._toResults(rows, scoreMap, ids, breakdownMap);
    }

    // Recency x authority is applied in _finalize, *after* rerank, not here.
    // Applied at this point the reranker overwrote it, so the term was the
    // whole ranking without a reranker and discarded with one.

    // Phase 3: 1-hop graph expansion (best-effort — skipped if tables don't exist)
    if (useGraph && results.length > 0) {
      try {
        results = await this._graphExpand(db, namespace, results, limit);
      } catch {
        // Graph tables may not exist yet — degrade gracefully
      }
    }

    // Sort by final score DESC before passing to reranker
    results.sort((a, b) => b.score - a.score);

    const finalResults = await this._finalize(results, text, limit, recencyAuthority, call, budget);

    // Phase C (C2): retrieval-hit tracking — fire-and-forget, never awaited,
    // never fails the query. Skippable for eval/assessment runs.
    if (trackHits && finalResults.length > 0) {
      this._recordHits(db, namespace, finalResults.map(r => r.id));
    }

    return finalResults;
  }

  /**
   * The vector leg's query embedding, as pgvector text: given, a stored
   * chunk's own (no embedding call), else `text` embedded. Null when there is
   * nothing to rank by (no embedder, or the chunk has no embedding).
   */
  private async _queryEmbedding(
    db: Awaited<ReturnType<typeof getDb>>,
    namespace: string,
    params: QueryParams,
    activeEmbedder: Embedder | null,
    column: VectorColumn,
    call: VoyageCall,
    budget: { denied: boolean },
  ): Promise<string | null> {
    if (params.embedding?.length) return vectorToString(params.embedding);
    if (params.nearChunkId) {
      if (!activeEmbedder) return null;
      const col = COLUMN_SQL[column];
      const res = await db.execute(sql`
        SELECT ${col}::text AS embedding FROM knowledge_chunks
        WHERE namespace = ${namespace} AND source_id = ${params.nearChunkId} AND ${col} IS NOT NULL
          AND embedding_model = ${activeEmbedder.model}
        LIMIT 1
      `);
      const row = (res.rows as Array<{ embedding: string | null }>)[0];
      return row?.embedding ?? null;
    }
    if (!activeEmbedder) return null;
    const vectors = await activeEmbedder.embed([params.text], 'query', call);
    if (!vectors) {
      budget.denied = true;
      return null;
    }
    return vectorToString(vectors[0]);
  }

  async embedQueries(namespace: string, texts: string[]): Promise<number[][] | null> {
    const embedder = await this._selectEmbedder(namespace);
    if (!embedder || texts.length === 0) return embedder ? [] : null;
    return embedder.embed(texts, 'query', { namespace, caller: this.caller });
  }

  /**
   * Increment hit_count / stamp last_hit_at on the chunks a query returned.
   * Single UPDATE, deliberately not awaited by the caller — retrieval must
   * never block or fail on hit bookkeeping (column may also predate the
   * migration on older databases).
   */
  private _recordHits(
    db: Awaited<ReturnType<typeof getDb>>,
    namespace: string,
    sourceIds: string[],
  ): void {
    try {
      const inList = sql.join(sourceIds.map(id => sql`${id}`), sql`, `);
      Promise.resolve(db.execute(sql`
        UPDATE knowledge_chunks
        SET hit_count = hit_count + 1,
            last_hit_at = NOW()
        WHERE namespace = ${namespace}
          AND source_id IN (${inList})
      `)).catch(() => {});
    } catch {
      // Hit tracking is best-effort by contract
    }
  }

  /**
   * 1-hop graph expansion:
   * 1. Map seed chunks → entity ids (via chunk_entities)
   * 2. Follow edges from those entities (via knowledge_edges)
   * 3. Fetch top chunk for each neighbor entity (via chunk_entities)
   * 4. Score expanded chunks: inherited_rrf × 0.7 × graphProximity
   */
  private async _graphExpand(
    db: Awaited<ReturnType<typeof getDb>>,
    namespace: string,
    seedResults: QueryResult[],
    limit: number,
  ): Promise<QueryResult[]> {
    if (seedResults.length === 0) return seedResults;

    const workspaceId = namespace.split(':')[0];
    const seedIds = seedResults.map(r => r.id);
    const inList = sql.join(seedIds.map(id => sql`${id}`), sql`, `);

    // Step 1: find entity ids for seed chunks
    const entityRes = await db.execute(sql`
      SELECT DISTINCT entity_id
      FROM chunk_entities
      WHERE namespace = ${namespace}
        AND chunk_source_id IN (${inList})
    `);
    const seedEntityIds = (entityRes.rows as unknown as EntityRow[]).map(r => r.entity_id);
    if (seedEntityIds.length === 0) return seedResults;

    // Step 2: 1-hop edge traversal (outgoing, excluding supersedes)
    const entityInList = sql.join(seedEntityIds.map(id => sql`${id}`), sql`, `);
    const edgeRes = await db.execute(sql`
      SELECT to_entity_id, weight
      FROM knowledge_edges
      WHERE workspace_id = ${workspaceId}
        AND from_entity_id IN (${entityInList})
        AND type != 'supersedes'
    `);
    const edges = edgeRes.rows as unknown as EdgeRow[];
    if (edges.length === 0) return seedResults;

    // Build edge weight map: neighborEntityId → max weight
    const neighborWeights = new Map<string, number>();
    for (const e of edges) {
      const w = parseFloat(e.weight);
      const existing = neighborWeights.get(e.to_entity_id) ?? 0;
      if (w > existing) neighborWeights.set(e.to_entity_id, w);
    }

    // Step 3: fetch the best chunk for each neighbor entity not already in seed set
    const existingIds = new Set(seedIds);
    const neighborEntityList = sql.join(
      Array.from(neighborWeights.keys()).map(id => sql`${id}`),
      sql`, `,
    );

    const neighborChunkRes = await db.execute(sql`
      SELECT DISTINCT ON (ce.entity_id)
             kc.source_id, kc.namespace, kc.corpus, kc.source_type,
             kc.source_path, kc.source_url, kc.content, kc.metadata
      FROM chunk_entities ce
      JOIN knowledge_chunks kc
        ON kc.source_id = ce.chunk_source_id
       AND kc.namespace = ce.namespace
      WHERE ce.entity_id IN (${neighborEntityList})
        AND kc.namespace = ${namespace}
        AND kc.is_current = true
      ORDER BY ce.entity_id, kc.source_ts DESC NULLS LAST
      LIMIT ${limit * 2}
    `);

    const neighborChunks = neighborChunkRes.rows as unknown as EntityChunkRow[];

    // Step 4: score expanded chunks and merge with seed results
    const expandedResults: QueryResult[] = [];
    for (const chunk of neighborChunks) {
      if (existingIds.has(chunk.source_id)) continue;

      // Find which entity links this chunk back to a seed entity to get the edge weight
      const graphProximity = neighborWeights.get(chunk.source_id) ?? 0.5;

      // Inherit score from the highest-scoring seed result (discounted by 0.7 for indirection)
      const inheritedScore = (seedResults[0]?.score ?? 0.5) * 0.7 * graphProximity;

      expandedResults.push({
        id: chunk.source_id,
        namespace: chunk.namespace,
        corpus: chunk.corpus,
        sourceType: chunk.source_type,
        sourcePath: chunk.source_path,
        sourceUrl: chunk.source_url,
        content: chunk.content,
        metadata: chunk.metadata ?? {},
        score: inheritedScore,
        graphProximity,
      });
      existingIds.add(chunk.source_id);
    }

    // Mark original seed results with graphProximity=1.0
    for (const r of seedResults) {
      r.graphProximity = 1.0;
    }

    return [...seedResults, ...expandedResults];
  }

  /** Phase 1: mark older chunks for the same source_path as superseded. */
  private async _markSuperseded(
    db: Awaited<ReturnType<typeof getDb>>,
    namespace: string,
    newSourceId: string,
    sourcePath: string,
    newSourceTs: Date,
  ): Promise<void> {
    try {
      await db.execute(sql`
        UPDATE knowledge_chunks
        SET is_current = false,
            superseded_by = ${newSourceId}
        WHERE namespace = ${namespace}
          AND source_path = ${sourcePath}
          AND source_id != ${newSourceId}
          AND is_current = true
          AND (source_ts IS NULL OR source_ts < ${newSourceTs.toISOString()})
      `);
    } catch {
      // Degrade gracefully if the column doesn't exist yet
    }
  }

  /**
   * Wave-1 C1: explicit supersession — mark the listed source_ids in the SAME
   * namespace as superseded by newSourceId. Only `is_current` rows match, so
   * the returned count reflects rows actually flipped; unknown ids are ignored.
   */
  private async _markSupersededExplicit(
    db: Awaited<ReturnType<typeof getDb>>,
    namespace: string,
    newSourceId: string,
    targetSourceIds: string[],
  ): Promise<number> {
    try {
      const inList = sql.join(targetSourceIds.map(id => sql`${id}`), sql`, `);
      const res = await db.execute(sql`
        UPDATE knowledge_chunks
        SET is_current = false,
            superseded_by = ${newSourceId}
        WHERE namespace = ${namespace}
          AND source_id IN (${inList})
          AND source_id != ${newSourceId}
          AND is_current = true
        RETURNING source_id
      `);
      return res.rows.length;
    } catch {
      // Degrade gracefully if the columns don't exist yet
      return 0;
    }
  }

  /**
   * Wave-1 C1: entity-keyed supersession (deterministic).
   *
   * Marks other `is_current` chunks in the namespace as superseded by
   * `newSourceId` when ALL of the following hold:
   *  - the candidate's `chunk_entities` rows with role='defines' form a
   *    non-empty set IDENTICAL to `entityIds` (strict exact-set match);
   *  - the candidate's `source_ts` is strictly older than the new chunk's
   *    (NULL counts as older, matching path-keyed supersession);
   *  - the candidate's corpus authority is ≤ the new chunk's corpus authority
   *    (per CORPUS_AUTHORITY).
   *
   * Single atomic UPDATE (no transaction — neon-http constraint). Returns the
   * number of chunks marked; degrades gracefully to 0 on any error.
   */
  async markSupersededByEntities(
    namespace: string,
    newSourceId: string,
    entityIds: string[],
    opts: { corpus?: Corpus; sourceTs?: Date | null } = {},
  ): Promise<number> {
    const uniqueIds = Array.from(new Set(entityIds.filter(Boolean)));
    if (uniqueIds.length === 0) return 0;

    const corpus = opts.corpus ?? (namespace.split(':')[1] as Corpus);
    const newAuthority = CORPUS_AUTHORITY[corpus] ?? 1.0;
    const allowedCorpora = (Object.keys(CORPUS_AUTHORITY) as Corpus[])
      .filter(c => CORPUS_AUTHORITY[c] <= newAuthority);
    const refTs = opts.sourceTs ?? new Date();

    try {
      const db = await getDb();
      const idList = sql.join(uniqueIds.map(id => sql`${id}`), sql`, `);
      const corpusList = sql.join(allowedCorpora.map(c => sql`${c}`), sql`, `);
      const res = await db.execute(sql`
        UPDATE knowledge_chunks
        SET is_current = false,
            superseded_by = ${newSourceId}
        WHERE namespace = ${namespace}
          AND source_id != ${newSourceId}
          AND is_current = true
          AND corpus IN (${corpusList})
          AND (source_ts IS NULL OR source_ts < ${refTs.toISOString()})
          AND source_id IN (
            SELECT ce.chunk_source_id
            FROM chunk_entities ce
            WHERE ce.namespace = ${namespace}
              AND ce.role = 'defines'
              AND ce.chunk_source_id != ${newSourceId}
            GROUP BY ce.chunk_source_id
            HAVING COUNT(DISTINCT ce.entity_id) = ${uniqueIds.length}
               AND COUNT(DISTINCT ce.entity_id) FILTER (WHERE ce.entity_id IN (${idList})) = ${uniqueIds.length}
          )
        RETURNING source_id
      `);
      return res.rows.length;
    } catch {
      // Entity tables may not exist yet — degrade gracefully
      return 0;
    }
  }

  /**
   * Rerank (when configured), then apply corpus authority x recency decay to
   * whatever score survived.
   *
   * Order matters and used to be wrong. `applyRecencyAuthority` ran before
   * `applyRerank`, and `applyRerank` *overwrites* `score` — so with a reranker
   * the age/authority term was computed and thrown away, and without one it
   * was the entire ranking. This package is constructed both ways in the same
   * deployment, so a query's ranking semantics depended on which code path
   * served it.
   *
   * Applying it here gives one policy in both: the reranker decides relevance,
   * then age and authority weight it. Callers owning these signals themselves
   * pass `recencyAuthority: false`.   *
   * Known limitation: applyRerank receives `limit`, so a real reranker cuts
   * candidates by relevance before age is considered. Widening that window is a
   * separate change.
   */
  private async _finalize(
    results: QueryResult[],
    text: string,
    limit: number,
    recencyAuthority: boolean,
    call: VoyageCall,
    budget: { denied: boolean },
  ): Promise<QueryResult[]> {
    let out = results;

    if (this.reranker && results.length > 1) {
      // Capture RRF scores before reranking overwrites score
      const rrfScores = new Map(results.map(r => [r.id, r.score]));
      // Graph expansion can add past candidateLimit; the cap is on what is billed.
      const candidates = results.slice(0, RERANK_CANDIDATE_CAP);
      const reranked = await applyRerank(this.reranker, text, candidates, limit, call);
      if (reranked) {
        // Tag per-signal scores: rrf (pre-rerank) and rerank (cross-encoder)
        out = reranked.map(r => ({
          ...r,
          scoreBreakdown: {
            ...(r.scoreBreakdown ?? {}),
            rrf: rrfScores.get(r.id),
            rerank: r.score,
          },
        }));
        // A reranker score is calibrated however the candidates were found.
        budget.denied = false;
      } else {
        budget.denied = true;
      }
    }

    if (budget.denied) {
      out = out.map(r => ({ ...r, scoreBreakdown: { ...(r.scoreBreakdown ?? {}), budgetFallback: true } }));
    }

    if (recencyAuthority && out.length > 0) {
      applyRecencyAuthority(out, new Date());
      // Re-sort: the weighting changed the ordering the reranker produced.
      out.sort((a, b) => b.score - a.score);
    }

    return out.slice(0, limit);
  }

  async delete(namespace: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await getDb();
    for (const id of ids) {
      await db.execute(sql`
        DELETE FROM knowledge_chunks
        WHERE namespace = ${namespace} AND source_id = ${id}
      `);
    }
  }

  async deleteBySource(
    namespace: string,
    selector: { sourcePath?: string; sourceType?: string; sourceIdPrefix?: string },
  ): Promise<void> {
    if (!selector.sourcePath && !selector.sourceType && !selector.sourceIdPrefix) return;
    const db = await getDb();
    const pathClause = selector.sourcePath ? sql`AND source_path = ${selector.sourcePath}` : sql``;
    const typeClause = selector.sourceType ? sql`AND source_type = ${selector.sourceType}` : sql``;
    // starts_with, not LIKE: an id may contain `_` or `%`.
    const idClause = selector.sourceIdPrefix ? sql`AND starts_with(source_id, ${selector.sourceIdPrefix})` : sql``;
    await db.execute(sql`
      DELETE FROM knowledge_chunks
      WHERE namespace = ${namespace}
        ${pathClause}
        ${typeClause}
        ${idClause}
    `);
  }

  async listNamespaces(): Promise<string[]> {
    const db = await getDb();
    const res = await db.execute(sql`
      SELECT DISTINCT namespace FROM knowledge_chunks ORDER BY namespace
    `);
    return (res.rows as Array<{ namespace: string }>).map(r => r.namespace);
  }

  /**
   * Return the stored file_hash per source path, but ONLY for paths whose chunks
   * all agree on a single non-null hash. A path with mixed hashes (should never
   * happen — deleteBySource clears before re-upsert) is omitted so the caller
   * re-ingests it rather than skipping on stale data.
   */
  async getFileHashes(namespace: string, sourcePaths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (sourcePaths.length === 0) return out;
    const db = await getDb();
    const inList = sql.join(sourcePaths.map(p => sql`${p}`), sql`, `);
    // A team that picked its embedding provider: a file embedded by another
    // model is not "unchanged", so the next ingest re-embeds it rather than
    // leaving it vector-invisible (the vector legs filter on embedding_model).
    // Teams on the default keep the plain skip, so nothing re-embeds for them.
    const model = await this._pickedModel(namespace);
    const modelClause = model ? sql`AND embedding_model = ${model}` : sql``;
    const res = await db.execute(sql`
      SELECT source_path, MIN(file_hash) AS file_hash
      FROM knowledge_chunks
      WHERE namespace = ${namespace}
        AND source_path IN (${inList})
        AND file_hash IS NOT NULL
        AND is_current = true
        ${modelClause}
      GROUP BY source_path
      HAVING COUNT(DISTINCT file_hash) = 1
    `);
    for (const row of res.rows as Array<{ source_path: string | null; file_hash: string | null }>) {
      if (row.source_path && row.file_hash) out.set(row.source_path, row.file_hash);
    }
    return out;
  }

  async touchBySource(namespace: string, sourcePaths: string[]): Promise<void> {
    if (sourcePaths.length === 0) return;
    const db = await getDb();
    const inList = sql.join(sourcePaths.map(p => sql`${p}`), sql`, `);
    await db.execute(sql`
      UPDATE knowledge_chunks
      SET updated_at = NOW()
      WHERE namespace = ${namespace}
        AND source_path IN (${inList})
        AND is_current = true
    `);
  }

  async listSourcePaths(namespace: string, prefix?: string): Promise<string[]> {
    const db = await getDb();
    // starts_with (not LIKE) so path segments with `_`/`%` aren't treated as
    // LIKE metacharacters. Matches the prefix dir itself or anything under it.
    const prefixClause = prefix
      ? sql`AND (source_path = ${prefix} OR starts_with(source_path, ${prefix + '/'}))`
      : sql``;
    const res = await db.execute(sql`
      SELECT DISTINCT source_path FROM knowledge_chunks
      WHERE namespace = ${namespace}
        AND source_path IS NOT NULL
        ${prefixClause}
    `);
    return (res.rows as Array<{ source_path: string | null }>)
      .map(r => r.source_path)
      .filter((p): p is string => !!p);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _vectorSearch(
    db: Awaited<ReturnType<typeof getDb>>,
    namespace: string,
    embeddingStr: string,
    filterClause: ReturnType<typeof sql>,
    currentClause: ReturnType<typeof sql>,
    limit: number,
    model: string | null,
    column: VectorColumn = 'embedding',
  ): Promise<Array<{ id: string; score: number }>> {
    // Null only for a caller-supplied vector with no embedder configured: the
    // model is unknown, so there is nothing to filter on.
    const modelClause = model ? sql`AND embedding_model = ${model}` : sql``;
    const col = COLUMN_SQL[column];
    const vectorRes = await db.execute(sql`
      SELECT source_id AS id,
             1 - (${col} <=> ${embeddingStr}::vector) AS score
      FROM knowledge_chunks
      WHERE namespace = ${namespace}
        AND ${col} IS NOT NULL
        ${modelClause}
        ${filterClause}
        ${currentClause}
      ORDER BY ${col} <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `);

    return (vectorRes.rows as Array<{ id: string; score: number }>)
      .map(r => ({ id: r.id, score: Number(r.score) }));
  }

  private async _fetchBySourceIds(
    db: Awaited<ReturnType<typeof getDb>>,
    namespace: string,
    sourceIds: string[],
    filterClause: ReturnType<typeof sql>,
    currentClause: ReturnType<typeof sql> = sql``,
  ): Promise<ChunkRow[]> {
    if (sourceIds.length === 0) return [];
    const inList = sql.join(sourceIds.map(id => sql`${id}`), sql`, `);
    const res = await db.execute(sql`
      SELECT source_id, namespace, corpus, source_type, source_path, source_url, content, metadata,
             source_ts, updated_at, is_current, superseded_by
      FROM knowledge_chunks
      WHERE namespace = ${namespace}
        AND source_id IN (${inList})
        ${filterClause}
        ${currentClause}
    `);
    return res.rows as unknown as ChunkRow[];
  }

  private _toResults(
    rows: ChunkRow[],
    scoreMap: Map<string, number>,
    orderedIds: string[],
    scoreBreakdownMap?: Map<string, QueryResult['scoreBreakdown']>,
  ): QueryResult[] {
    const byId = new Map(rows.map(r => [r.source_id, r]));
    return orderedIds
      .map(id => {
        const row = byId.get(id);
        if (!row) return null;
        const result: QueryResult = {
          id: row.source_id,
          namespace: row.namespace,
          corpus: row.corpus,
          sourceType: row.source_type,
          sourcePath: row.source_path,
          sourceUrl: row.source_url,
          content: row.content,
          metadata: row.metadata ?? {},
          score: scoreMap.get(id) ?? 0,
          createdAt: row.updated_at ? new Date(row.updated_at) : null,
          isCurrent: row.is_current ?? true,
          sourceTs: row.source_ts ? new Date(row.source_ts) : null,
          updatedAt: row.updated_at ? new Date(row.updated_at) : null,
          supersededBy: row.superseded_by ?? null,
          scoreBreakdown: scoreBreakdownMap?.get(id) ?? undefined,
        };
        return result;
      })
      .filter((r): r is QueryResult => r !== null);
  }

  async countNamespace(namespace: string): Promise<number> {
    const db = await getDb();
    const res = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM knowledge_chunks WHERE namespace = ${namespace} AND is_current = true
    `);
    return Number((res.rows[0] as Record<string, unknown>)?.cnt ?? 0);
  }

  /**
   * Check for near-duplicates before writing. Returns raw cosine similarity
   * (no recency scoring) so callers can compare against fixed thresholds.
   */
  async nearDupeCheck(
    namespace: string,
    content: string,
    topK = 5,
  ): Promise<Array<{ id: string; similarity: number; content: string; sourceUrl: string | null }>> {
    const selected = await this._selectEmbedder(namespace);
    if (!selected) return [];

    try {
      const db = await getDb();
      const { embedder: activeEmbedder, column } = await this._space(db, namespace, selected);
      if (!activeEmbedder) return [];
      const vectors = await activeEmbedder.embed([content], 'document', { namespace, caller: this.caller });
      if (!vectors) return [];
      const embeddingStr = vectorToString(vectors[0]);
      const col = COLUMN_SQL[column];

      const res = await db.execute(sql`
        SELECT source_id AS id,
               1 - (${col} <=> ${embeddingStr}::vector) AS similarity,
               content,
               source_url
        FROM knowledge_chunks
        WHERE namespace = ${namespace}
          AND ${col} IS NOT NULL
          AND embedding_model = ${activeEmbedder.model}
          AND is_current = true
        ORDER BY ${col} <=> ${embeddingStr}::vector
        LIMIT ${topK}
      `);

      return (res.rows as Array<{
        id: string;
        similarity: string | number;
        content: string;
        source_url: string | null;
      }>).map(r => ({
        id: r.id,
        similarity: Number(r.similarity),
        content: r.content,
        sourceUrl: r.source_url,
      }));
    } catch {
      return [];
    }
  }

  /**
   * One bounded step of a namespace's re-embed (spec §5.3 D-3, D-6): the next
   * `batchSize` current rows not yet in the namespace's space, oldest id first,
   * get their vector written into the namespace's column with the other size
   * columns cleared and `embedding_model` set. Resumable by its predicate
   * (rows already in the space are never re-read), bounded per call so it
   * never starves live work; the caller ticks it until `remaining` is 0. A
   * guard refusal leaves the rows for the next tick (`denied`). Nothing here
   * casts or copies a vector between columns.
   */
  async reembedNamespace(namespace: string, opts: { batchSize?: number } = {}): Promise<{
    status: 'done' | 'running' | 'denied' | 'skipped';
    processed: number;
    remaining: number;
  }> {
    const batchSize = Math.max(1, Math.min(256, opts.batchSize ?? 32));
    const db = await getDb();
    const { embedder, column } = await this._space(db, namespace, await this._selectEmbedder(namespace));
    if (!embedder) return { status: 'skipped', processed: 0, remaining: 0 };
    const col = COLUMN_SQL[column];
    const exec = (q: ReturnType<typeof sql>) => db.execute(q);
    const due = sql`namespace = ${namespace} AND is_current = true AND (embedding_model IS DISTINCT FROM ${embedder.model} OR ${col} IS NULL)`;

    const batch = await db.execute(sql`
      SELECT id, coalesce(lexical_text, content) AS text
      FROM knowledge_chunks
      WHERE ${due}
      ORDER BY id
      LIMIT ${batchSize}
    `);
    const rows = (batch.rows ?? []) as Array<{ id: string; text: string }>;
    if (rows.length === 0) {
      await markReembed(namespace, 'done', exec);
      return { status: 'done', processed: 0, remaining: 0 };
    }
    await markReembed(namespace, 'running', exec);

    const texts = [...new Set(rows.map(r => stripNulBytes(r.text)))];
    const vectors = await embedder.embed(texts, 'document', { namespace, caller: this.caller });
    if (!vectors) return { status: 'denied', processed: 0, remaining: rows.length };
    const byText = new Map(texts.map((t, i) => [t, vectors[i]]));

    let processed = 0;
    for (const row of rows) {
      const v = byText.get(stripNulBytes(row.text));
      if (!v || v.length !== embedder.dimensions) continue;
      await db.execute(sql`
        UPDATE knowledge_chunks
        SET ${col} = ${vectorToString(v)}::vector, ${nullOtherColumns(column)}, embedding_model = ${embedder.model}
        WHERE id = ${row.id}::uuid
      `);
      processed++;
    }
    await markReembed(namespace, 'running', exec, processed);

    const left = await db.execute(sql`SELECT count(*) AS cnt FROM knowledge_chunks WHERE ${due}`);
    const remaining = Number((left.rows?.[0] as Record<string, unknown> | undefined)?.cnt ?? 0);
    if (remaining === 0) {
      await markReembed(namespace, 'done', exec);
      return { status: 'done', processed, remaining: 0 };
    }
    return { status: 'running', processed, remaining };
  }
}
