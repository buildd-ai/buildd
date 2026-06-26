import { sql } from 'drizzle-orm';
import type { KnowledgeStore, UpsertChunk, QueryResult, QueryParams, Embedder, Reranker, Corpus } from './types';
import { applyRerank } from './reranker';
import { getCodeEmbedder, isCodeCorpus } from './voyage-embedder';
import { createHash } from 'crypto';
import {
  buildNamespace as _buildNamespace,
  reciprocalRankFusion,
  applyRecencyAuthority,
  CORPUS_AUTHORITY,
  HALF_LIFE_DAYS,
  recencyDecay,
} from './scoring';

// Re-export pure scoring utilities so callers only need one import.
export { reciprocalRankFusion, applyRecencyAuthority, CORPUS_AUTHORITY, HALF_LIFE_DAYS, recencyDecay };

// Lazy DB import — avoids hitting DATABASE_URL during build/test
async function getDb() {
  const { db } = await import('../db/index');
  return db;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function buildNamespace(workspaceId: string, corpus: Corpus): string {
  return _buildNamespace(workspaceId, corpus);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function vectorToString(v: number[]): string {
  return `[${v.join(',')}]`;
}

// ── Feature flag ─────────────────────────────────────────────────────────────

function isRecencyAuthorityEnabled(override?: boolean): boolean {
  if (override !== undefined) return override;
  const env = process.env.ENABLE_RECENCY_AUTHORITY;
  // Disabled only when explicitly set to '0' or 'false'. On by default.
  return env !== '0' && env !== 'false';
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
  source_ts: string | null;
  score?: number;
}

// ── PgVectorStore ────────────────────────────────────────────────────────────

export class PgVectorStore implements KnowledgeStore {
  constructor(
    private readonly embedder: Embedder | null,
    private readonly reranker: Reranker | null = null,
  ) {}

  /** Select the embedder appropriate for the given corpus.
   *  code/docs/spec → voyage-code-3 via singleton; others → the constructor embedder. */
  private _selectEmbedder(corpus: Corpus): Embedder | null {
    if (isCodeCorpus(corpus)) {
      return getCodeEmbedder() ?? this.embedder;
    }
    return this.embedder;
  }

  async upsert(namespace: string, chunks: UpsertChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const db = await getDb();
    const corpus = namespace.split(':')[1] as Corpus;
    const activeEmbedder = this._selectEmbedder(corpus);

    // Compute embeddings for all chunks in one batch call
    const texts = chunks.map(c => c.lexicalText ?? c.content);
    const embeddings = activeEmbedder
      ? await activeEmbedder.embed(texts)
      : chunks.map(() => null);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      const contentHash = sha256(chunk.content);
      const lexicalText = chunk.lexicalText ?? chunk.content;
      const sourceTs = chunk.sourceTs ?? null;

      if (embedding) {
        await db.execute(sql`
          INSERT INTO knowledge_chunks
            (source_id, namespace, corpus, source_type, source_path, source_url,
             content, lexical_text, embedding, embedding_model, metadata, content_hash,
             source_ts, is_current, updated_at)
          VALUES
            (${chunk.id}, ${namespace}, ${corpus}, ${chunk.sourceType},
             ${chunk.sourcePath ?? null}, ${chunk.sourceUrl ?? null},
             ${chunk.content}, ${lexicalText},
             ${vectorToString(embedding)}::vector,
             ${activeEmbedder!.model},
             ${JSON.stringify(chunk.metadata ?? {})}::jsonb,
             ${contentHash},
             ${sourceTs ? sourceTs.toISOString() : null}::timestamptz,
             true,
             NOW())
          ON CONFLICT (namespace, source_id) DO UPDATE SET
            content         = EXCLUDED.content,
            lexical_text    = EXCLUDED.lexical_text,
            embedding       = EXCLUDED.embedding,
            embedding_model = EXCLUDED.embedding_model,
            metadata        = EXCLUDED.metadata,
            content_hash    = EXCLUDED.content_hash,
            source_path     = EXCLUDED.source_path,
            source_url      = EXCLUDED.source_url,
            source_ts       = CASE
                                WHEN EXCLUDED.source_ts IS NOT NULL THEN EXCLUDED.source_ts
                                ELSE knowledge_chunks.source_ts
                              END,
            is_current      = true,
            superseded_by   = NULL,
            updated_at      = NOW()
        `);
      } else {
        // No embedder — store text-only (lexical search will still work)
        await db.execute(sql`
          INSERT INTO knowledge_chunks
            (source_id, namespace, corpus, source_type, source_path, source_url,
             content, lexical_text, metadata, content_hash,
             source_ts, is_current, updated_at)
          VALUES
            (${chunk.id}, ${namespace}, ${corpus}, ${chunk.sourceType},
             ${chunk.sourcePath ?? null}, ${chunk.sourceUrl ?? null},
             ${chunk.content}, ${lexicalText},
             ${JSON.stringify(chunk.metadata ?? {})}::jsonb,
             ${contentHash},
             ${sourceTs ? sourceTs.toISOString() : null}::timestamptz,
             true,
             NOW())
          ON CONFLICT (namespace, source_id) DO UPDATE SET
            content       = EXCLUDED.content,
            lexical_text  = EXCLUDED.lexical_text,
            metadata      = EXCLUDED.metadata,
            content_hash  = EXCLUDED.content_hash,
            source_path   = EXCLUDED.source_path,
            source_url    = EXCLUDED.source_url,
            source_ts     = CASE
                              WHEN EXCLUDED.source_ts IS NOT NULL THEN EXCLUDED.source_ts
                              ELSE knowledge_chunks.source_ts
                            END,
            is_current    = true,
            superseded_by = NULL,
            updated_at    = NOW()
        `);
      }

      // Coarse supersession: mark older chunks for the same source_path as not current.
      // Uses source_path as a proxy entity key until Phase 2 introduces entity ids.
      // This is a no-op when deleteBySource was called first (the normal ingest path)
      // but matters for direct upserts where history is retained.
      if (chunk.sourcePath && sourceTs) {
        await db.execute(sql`
          UPDATE knowledge_chunks
          SET    is_current    = false,
                 superseded_by = ${chunk.id}
          WHERE  namespace     = ${namespace}
            AND  source_path   = ${chunk.sourcePath}
            AND  source_id    != ${chunk.id}
            AND  is_current    = true
            AND  (source_ts IS NULL OR source_ts < ${sourceTs.toISOString()}::timestamptz)
        `);
      }
    }
  }

  async query(namespace: string, params: QueryParams): Promise<QueryResult[]> {
    const {
      text,
      mode = 'hybrid',
      topK = 10,
      filters,
      history = false,
      rerankInstruction,
      useRecencyAuthority,
    } = params;
    const db = await getDb();
    const corpus = namespace.split(':')[1] as Corpus;
    // Use corpus-appropriate embedder so query vectors match the stored chunk vectors
    const activeEmbedder = this._selectEmbedder(corpus);
    const limit = Math.min(topK, 50);
    // When a reranker is configured, retrieve a wider candidate pool so the
    // cross-encoder has more to work with, then trim back to `limit`.
    const candidateLimit = this.reranker ? Math.min(limit * 5, 100) : limit;

    // Apply optional corpus/sourceType filter as SQL
    const filterClause = filters?.corpus
      ? sql`AND corpus = ${filters.corpus}`
      : filters?.sourceType
      ? sql`AND source_type = ${filters.sourceType}`
      : sql``;

    // Supersession filter: exclude superseded chunks unless history mode requested
    const currentClause = history ? sql`` : sql`AND is_current = true`;

    let chunkRows: ChunkRow[];
    let rrfScores: Map<string, number> | null = null;

    if (mode === 'vector' || (mode === 'hybrid' && activeEmbedder)) {
      // Asymmetric retrieval: embed the query with input_type='query' while
      // stored chunks were embedded as 'document' (the upsert default).
      const [queryEmbedding] = await activeEmbedder!.embed([text], 'query');
      const embeddingStr = vectorToString(queryEmbedding);

      const vectorRes = await db.execute(sql`
        SELECT source_id AS id,
               1 - (embedding <=> ${embeddingStr}::vector) AS score
        FROM knowledge_chunks
        WHERE namespace = ${namespace}
          AND embedding IS NOT NULL
          ${currentClause}
          ${filterClause}
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${limit * 2}
      `);

      const vectorRanked = (vectorRes.rows as Array<{ id: string; score: number }>)
        .map((r, idx) => ({ id: r.id, score: Number(r.score) }));

      if (mode === 'vector') {
        // Vector-only: fetch full rows for top results
        const ids = vectorRanked.slice(0, candidateLimit).map(r => r.id);
        if (ids.length === 0) return [];
        const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause, currentClause);
        const scoreMap = new Map(vectorRanked.map(r => [r.id, r.score]));
        return this._finalize(this._toResults(rows, scoreMap, ids), text, limit, rerankInstruction, useRecencyAuthority);
      }

      // Hybrid: also run lexical, then fuse
      const lexicalRes = await db.execute(sql`
        SELECT source_id AS id,
               ts_rank(to_tsvector('english', coalesce(lexical_text, content)),
                       websearch_to_tsquery('english', ${text})) AS score
        FROM knowledge_chunks
        WHERE namespace = ${namespace}
          AND to_tsvector('english', coalesce(lexical_text, content))
              @@ websearch_to_tsquery('english', ${text})
          ${currentClause}
          ${filterClause}
        ORDER BY score DESC
        LIMIT ${limit * 2}
      `);

      const lexicalRanked = (lexicalRes.rows as Array<{ id: string; score: number }>)
        .map(r => ({ id: r.id, score: Number(r.score) }));

      const fused = reciprocalRankFusion(vectorRanked, lexicalRanked).slice(0, candidateLimit);
      rrfScores = new Map(fused.map(r => [r.id, r.score]));

      const ids = fused.map(r => r.id);
      if (ids.length === 0) return [];
      const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause, currentClause);
      return this._finalize(this._toResults(rows, rrfScores, ids), text, limit, rerankInstruction, useRecencyAuthority);
    }

    // Lexical-only
    const lexOnlyRes = await db.execute(sql`
      SELECT source_id AS id,
             ts_rank(to_tsvector('english', coalesce(lexical_text, content)),
                     websearch_to_tsquery('english', ${text})) AS score
      FROM knowledge_chunks
      WHERE namespace = ${namespace}
        AND to_tsvector('english', coalesce(lexical_text, content))
            @@ websearch_to_tsquery('english', ${text})
        ${currentClause}
        ${filterClause}
      ORDER BY score DESC
      LIMIT ${candidateLimit}
    `);

    const lexRanked = (lexOnlyRes.rows as Array<{ id: string; score: number }>)
      .map(r => ({ id: r.id, score: Number(r.score) }));

    if (lexRanked.length === 0) return [];
    const ids = lexRanked.map(r => r.id);
    const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause, currentClause);
    const scoreMap = new Map(lexRanked.map(r => [r.id, r.score]));
    return this._finalize(this._toResults(rows, scoreMap, ids), text, limit, rerankInstruction, useRecencyAuthority);
  }

  /**
   * Apply the optional reranker (semantic relevance), then recency × authority
   * multipliers, then trim to `limit`.
   *
   * Pipeline: reranker (semantic, optional) → applyRecencyAuthority (deterministic) → slice
   * The reranker refines semantic relevance; the multipliers ensure recency/authority
   * are never overridden by the semantic model.
   */
  private async _finalize(
    results: QueryResult[],
    text: string,
    limit: number,
    rerankInstruction?: string,
    useRecencyAuthorityOverride?: boolean,
  ): Promise<QueryResult[]> {
    // Step 1: optional cross-encoder reranker (semantic relevance)
    let reranked = results;
    if (this.reranker && results.length > 1) {
      reranked = await applyRerank(this.reranker, text, results, limit, rerankInstruction);
    }

    // Step 2: deterministic recency × authority multipliers
    if (isRecencyAuthorityEnabled(useRecencyAuthorityOverride)) {
      reranked = applyRecencyAuthority(reranked, new Date());
      // Re-sort after multipliers change relative order
      reranked = reranked.sort((a, b) => b.score - a.score);
    }

    return reranked.slice(0, limit);
  }

  async delete(namespace: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await getDb();
    // Delete by source_id (the stable external id like memoryId)
    for (const id of ids) {
      await db.execute(sql`
        DELETE FROM knowledge_chunks
        WHERE namespace = ${namespace} AND source_id = ${id}
      `);
    }
  }

  async deleteBySource(
    namespace: string,
    selector: { sourcePath?: string; sourceType?: string },
  ): Promise<void> {
    if (!selector.sourcePath && !selector.sourceType) return;
    const db = await getDb();
    const pathClause = selector.sourcePath ? sql`AND source_path = ${selector.sourcePath}` : sql``;
    const typeClause = selector.sourceType ? sql`AND source_type = ${selector.sourceType}` : sql``;
    await db.execute(sql`
      DELETE FROM knowledge_chunks
      WHERE namespace = ${namespace}
        ${pathClause}
        ${typeClause}
    `);
  }

  async listNamespaces(): Promise<string[]> {
    const db = await getDb();
    const res = await db.execute(sql`
      SELECT DISTINCT namespace FROM knowledge_chunks ORDER BY namespace
    `);
    return (res.rows as Array<{ namespace: string }>).map(r => r.namespace);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _fetchBySourceIds(
    db: Awaited<ReturnType<typeof getDb>>,
    namespace: string,
    sourceIds: string[],
    filterClause: ReturnType<typeof sql>,
    currentClause: ReturnType<typeof sql>,
  ): Promise<ChunkRow[]> {
    if (sourceIds.length === 0) return [];
    const inList = sql.join(sourceIds.map(id => sql`${id}`), sql`, `);
    const res = await db.execute(sql`
      SELECT source_id, namespace, corpus, source_type, source_path, source_url,
             content, metadata, source_ts
      FROM knowledge_chunks
      WHERE namespace = ${namespace}
        AND source_id IN (${inList})
        ${currentClause}
        ${filterClause}
    `);
    return res.rows as unknown as ChunkRow[];
  }

  private _toResults(
    rows: ChunkRow[],
    scoreMap: Map<string, number>,
    orderedIds: string[],
  ): QueryResult[] {
    const byId = new Map(rows.map(r => [r.source_id, r]));
    return orderedIds
      .map(id => {
        const row = byId.get(id);
        if (!row) return null;
        const sourceTs = row.source_ts ? new Date(row.source_ts) : null;
        return {
          id: row.source_id,
          namespace: row.namespace,
          corpus: row.corpus,
          sourceType: row.source_type,
          sourcePath: row.source_path,
          sourceUrl: row.source_url,
          content: row.content,
          metadata: row.metadata ?? {},
          score: scoreMap.get(id) ?? 0,
          sourceTs,
        } satisfies QueryResult;
      })
      .filter((r): r is QueryResult => r !== null);
  }
}
