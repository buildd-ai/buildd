import { sql } from 'drizzle-orm';
import type { KnowledgeStore, UpsertChunk, QueryResult, QueryParams, Embedder, Reranker, Corpus } from './types';
import { applyRerank } from './reranker';
import { getCodeEmbedder, isCodeCorpus } from './voyage-embedder';
import { applyRecencyAuthority } from './recency-authority';
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

  async upsert(namespace: string, chunks: UpsertChunk[]): Promise<void> {
    if (chunks.length === 0) return;

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
      const contentHash = sha256(chunk.content);
      const lexicalText = chunk.lexicalText ?? chunk.content;
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
             source_ts, updated_at)
          VALUES
            (${chunk.id}, ${namespace}, ${corpus}, ${chunk.sourceType},
             ${chunk.sourcePath ?? null}, ${chunk.sourceUrl ?? null},
             ${chunk.content}, ${lexicalText},
             ${vectorToString(embedding)}::vector,
             ${activeEmbedder!.model},
             ${JSON.stringify(metadataWithTs)}::jsonb,
             ${contentHash},
             ${sourceTs ? sourceTs.toISOString() : null},
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
            source_ts       = EXCLUDED.source_ts,
            updated_at      = NOW()
        `);
      } else {
        await db.execute(sql`
          INSERT INTO knowledge_chunks
            (source_id, namespace, corpus, source_type, source_path, source_url,
             content, lexical_text, metadata, content_hash, source_ts, updated_at)
          VALUES
            (${chunk.id}, ${namespace}, ${corpus}, ${chunk.sourceType},
             ${chunk.sourcePath ?? null}, ${chunk.sourceUrl ?? null},
             ${chunk.content}, ${lexicalText},
             ${JSON.stringify(metadataWithTs)}::jsonb,
             ${contentHash},
             ${sourceTs ? sourceTs.toISOString() : null},
             NOW())
          ON CONFLICT (namespace, source_id) DO UPDATE SET
            content      = EXCLUDED.content,
            lexical_text = EXCLUDED.lexical_text,
            metadata     = EXCLUDED.metadata,
            content_hash = EXCLUDED.content_hash,
            source_path  = EXCLUDED.source_path,
            source_url   = EXCLUDED.source_url,
            source_ts    = EXCLUDED.source_ts,
            updated_at   = NOW()
        `);
      }

      // Phase 1: supersession — mark older same-path chunks as not current
      if (chunk.sourcePath && sourceTs) {
        await this._markSuperseded(db, namespace, chunk.id, chunk.sourcePath, sourceTs);
      }
    }
  }

  async query(namespace: string, params: QueryParams): Promise<QueryResult[]> {
    const { text, mode = 'hybrid', topK = 10, filters, useGraph = true, history = false } = params;
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

    return this._finalize(results, text, limit);
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
      SELECT source_id, namespace, corpus, source_type, source_path, source_url, content, metadata
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
        } satisfies QueryResult;
      })
      .filter((r): r is QueryResult => r !== null);
  }
}
