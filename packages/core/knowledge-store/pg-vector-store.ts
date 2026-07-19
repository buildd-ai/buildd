import { sql } from 'drizzle-orm';
import type { KnowledgeStore, UpsertChunk, UpsertResult, QueryResult, QueryParams, Embedder, Reranker, Corpus } from './types';
import { applyRerank } from './reranker';
import { getCodeEmbedder, isCodeCorpus } from './voyage-embedder';
import { applyRecencyAuthority, CORPUS_AUTHORITY } from './recency-authority';
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

export class PgVectorStore implements KnowledgeStore {
  constructor(
    private readonly embedder: Embedder | null,
    private readonly reranker: Reranker | null = null,
  ) {}

  private _selectEmbedder(corpus: Corpus): Embedder | null {
    if (isCodeCorpus(corpus)) {
      return getCodeEmbedder() ?? this.embedder;
    }
    return this.embedder;
  }

  async upsert(namespace: string, chunks: UpsertChunk[]): Promise<UpsertResult> {
    if (chunks.length === 0) return { superseded: 0 };

    let superseded = 0;
    const db = await getDb();
    const corpus = namespace.split(':')[1] as Corpus;
    const activeEmbedder = this._selectEmbedder(corpus);

    const texts = chunks.map(c => c.lexicalText ?? c.content);
    const embeddings = activeEmbedder
      ? await activeEmbedder.embed(texts)
      : chunks.map(() => null);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      const rawLexicalText = chunk.lexicalText ?? chunk.content;
      // Defensively strip any stray NUL bytes before they hit the INSERT —
      // Postgres text columns reject 0x00 outright (see stripNulBytes above).
      const clean = sanitizeChunkForInsert(chunk, rawLexicalText);
      const contentHash = sha256(clean.content);
      const fileHash = chunk.fileHash ?? null;
      const sourceTs = chunk.sourceTs ?? null;

      // Write source_ts into metadata so recency scoring can read it on query
      const metadataWithTs = {
        ...(chunk.metadata ?? {}),
        ...(sourceTs ? { source_ts: sourceTs.toISOString() } : {}),
      };

      if (embedding) {
        await db.execute(sql`
          INSERT INTO knowledge_chunks
            (source_id, namespace, corpus, source_type, source_path, source_url,
             content, lexical_text, embedding, embedding_model, metadata, content_hash,
             file_hash, source_ts, updated_at)
          VALUES
            (${clean.sourceId}, ${namespace}, ${corpus}, ${clean.sourceType},
             ${clean.sourcePath}, ${clean.sourceUrl},
             ${clean.content}, ${clean.lexicalText},
             ${vectorToString(embedding)}::vector,
             ${activeEmbedder!.model},
             ${JSON.stringify(metadataWithTs)}::jsonb,
             ${contentHash},
             ${fileHash},
             ${sourceTs ? sourceTs.toISOString() : null},
             NOW())
          ON CONFLICT (namespace, source_id) DO UPDATE SET
            content         = EXCLUDED.content,
            lexical_text    = EXCLUDED.lexical_text,
            embedding       = EXCLUDED.embedding,
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

    return { superseded };
  }

  async query(namespace: string, params: QueryParams): Promise<QueryResult[]> {
    const { text, mode = 'hybrid', topK = 10, filters, useGraph = true, history = false, trackHits = true } = params;
    const db = await getDb();
    const corpus = namespace.split(':')[1] as Corpus;
    const activeEmbedder = this._selectEmbedder(corpus);
    const limit = Math.min(topK, 50);
    const candidateLimit = this.reranker ? Math.min(limit * 5, 100) : limit;

    const filterClause = filters?.corpus
      ? sql`AND corpus = ${filters.corpus}`
      : filters?.sourceType
      ? sql`AND source_type = ${filters.sourceType}`
      : sql``;

    // Phase 1: filter superseded chunks (unless history mode)
    const currentClause = history ? sql`` : sql`AND is_current = true`;

    let results: QueryResult[];

    if (mode === 'vector' || (mode === 'hybrid' && activeEmbedder)) {
      const [queryEmbedding] = await activeEmbedder!.embed([text], 'query');
      const embeddingStr = vectorToString(queryEmbedding);

      const vectorRes = await db.execute(sql`
        SELECT source_id AS id,
               1 - (embedding <=> ${embeddingStr}::vector) AS score
        FROM knowledge_chunks
        WHERE namespace = ${namespace}
          AND embedding IS NOT NULL
          ${filterClause}
          ${currentClause}
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${limit * 2}
      `);

      const vectorRanked = (vectorRes.rows as Array<{ id: string; score: number }>)
        .map(r => ({ id: r.id, score: Number(r.score) }));

      if (mode === 'vector') {
        const ids = vectorRanked.slice(0, candidateLimit).map(r => r.id);
        if (ids.length === 0) return [];
        const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause, currentClause);
        const scoreMap = new Map(vectorRanked.map(r => [r.id, r.score]));
        results = this._toResults(rows, scoreMap, ids);
      } else {
        const lexicalRes = await db.execute(sql`
          SELECT source_id AS id,
                 ts_rank(to_tsvector('english', coalesce(lexical_text, content)),
                         websearch_to_tsquery('english', ${text})) AS score
          FROM knowledge_chunks
          WHERE namespace = ${namespace}
            AND to_tsvector('english', coalesce(lexical_text, content))
                @@ websearch_to_tsquery('english', ${text})
            ${filterClause}
            ${currentClause}
          ORDER BY score DESC
          LIMIT ${limit * 2}
        `);

        const lexicalRanked = (lexicalRes.rows as Array<{ id: string; score: number }>)
          .map(r => ({ id: r.id, score: Number(r.score) }));

        const fused = reciprocalRankFusion(vectorRanked, lexicalRanked).slice(0, candidateLimit);
        const rrfScores = new Map(fused.map(r => [r.id, r.score]));

        const ids = fused.map(r => r.id);
        if (ids.length === 0) return [];
        const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause, currentClause);
        results = this._toResults(rows, rrfScores, ids);
      }
    } else {
      // Lexical-only
      const lexOnlyRes = await db.execute(sql`
        SELECT source_id AS id,
               ts_rank(to_tsvector('english', coalesce(lexical_text, content)),
                       websearch_to_tsquery('english', ${text})) AS score
        FROM knowledge_chunks
        WHERE namespace = ${namespace}
          AND to_tsvector('english', coalesce(lexical_text, content))
              @@ websearch_to_tsquery('english', ${text})
          ${filterClause}
          ${currentClause}
        ORDER BY score DESC
        LIMIT ${candidateLimit}
      `);

      const lexRanked = (lexOnlyRes.rows as Array<{ id: string; score: number }>)
        .map(r => ({ id: r.id, score: Number(r.score) }));

      if (lexRanked.length === 0) return [];
      const ids = lexRanked.map(r => r.id);
      const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause, currentClause);
      const scoreMap = new Map(lexRanked.map(r => [r.id, r.score]));
      results = this._toResults(rows, scoreMap, ids);
    }

    // Phase 1: apply recency × authority reranking
    applyRecencyAuthority(results, new Date());

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

    const finalResults = await this._finalize(results, text, limit);

    // Phase C (C2): retrieval-hit tracking — fire-and-forget, never awaited,
    // never fails the query. Skippable for eval/assessment runs.
    if (trackHits && finalResults.length > 0) {
      this._recordHits(db, namespace, finalResults.map(r => r.id));
    }

    return finalResults;
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

  private async _finalize(results: QueryResult[], text: string, limit: number): Promise<QueryResult[]> {
    if (!this.reranker || results.length <= 1) return results.slice(0, limit);
    const reranked = await applyRerank(this.reranker, text, results, limit);
    return reranked.slice(0, limit);
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
    currentClause: ReturnType<typeof sql> = sql``,
  ): Promise<ChunkRow[]> {
    if (sourceIds.length === 0) return [];
    const inList = sql.join(sourceIds.map(id => sql`${id}`), sql`, `);
    const res = await db.execute(sql`
      SELECT source_id, namespace, corpus, source_type, source_path, source_url, content, metadata,
             updated_at, is_current
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
}
