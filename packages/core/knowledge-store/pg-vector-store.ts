import { sql } from 'drizzle-orm';
import type { KnowledgeStore, UpsertChunk, QueryResult, QueryParams, Embedder, Corpus } from './types';
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
  score?: number;
}

// ── PgVectorStore ────────────────────────────────────────────────────────────

export class PgVectorStore implements KnowledgeStore {
  constructor(private readonly embedder: Embedder | null) {}

  async upsert(namespace: string, chunks: UpsertChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const db = await getDb();
    const corpus = namespace.split(':')[1] as Corpus;

    // Compute embeddings for all chunks in one batch call
    const texts = chunks.map(c => c.lexicalText ?? c.content);
    const embeddings = this.embedder
      ? await this.embedder.embed(texts)
      : chunks.map(() => null);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      const contentHash = sha256(chunk.content);
      const lexicalText = chunk.lexicalText ?? chunk.content;

      if (embedding) {
        await db.execute(sql`
          INSERT INTO knowledge_chunks
            (source_id, namespace, corpus, source_type, source_path, source_url,
             content, lexical_text, embedding, embedding_model, metadata, content_hash, updated_at)
          VALUES
            (${chunk.id}, ${namespace}, ${corpus}, ${chunk.sourceType},
             ${chunk.sourcePath ?? null}, ${chunk.sourceUrl ?? null},
             ${chunk.content}, ${lexicalText},
             ${vectorToString(embedding)}::vector,
             ${this.embedder!.model},
             ${JSON.stringify(chunk.metadata ?? {})}::jsonb,
             ${contentHash}, NOW())
          ON CONFLICT (namespace, source_id) DO UPDATE SET
            content       = EXCLUDED.content,
            lexical_text  = EXCLUDED.lexical_text,
            embedding     = EXCLUDED.embedding,
            embedding_model = EXCLUDED.embedding_model,
            metadata      = EXCLUDED.metadata,
            content_hash  = EXCLUDED.content_hash,
            source_path   = EXCLUDED.source_path,
            source_url    = EXCLUDED.source_url,
            updated_at    = NOW()
        `);
      } else {
        // No embedder — store text-only (lexical search will still work)
        await db.execute(sql`
          INSERT INTO knowledge_chunks
            (source_id, namespace, corpus, source_type, source_path, source_url,
             content, lexical_text, metadata, content_hash, updated_at)
          VALUES
            (${chunk.id}, ${namespace}, ${corpus}, ${chunk.sourceType},
             ${chunk.sourcePath ?? null}, ${chunk.sourceUrl ?? null},
             ${chunk.content}, ${lexicalText},
             ${JSON.stringify(chunk.metadata ?? {})}::jsonb,
             ${contentHash}, NOW())
          ON CONFLICT (namespace, source_id) DO UPDATE SET
            content      = EXCLUDED.content,
            lexical_text = EXCLUDED.lexical_text,
            metadata     = EXCLUDED.metadata,
            content_hash = EXCLUDED.content_hash,
            source_path  = EXCLUDED.source_path,
            source_url   = EXCLUDED.source_url,
            updated_at   = NOW()
        `);
      }
    }
  }

  async query(namespace: string, params: QueryParams): Promise<QueryResult[]> {
    const { text, mode = 'hybrid', topK = 10, filters } = params;
    const db = await getDb();
    const limit = Math.min(topK, 50);

    // Apply optional corpus/sourceType filter as SQL
    const filterClause = filters?.corpus
      ? sql`AND corpus = ${filters.corpus}`
      : filters?.sourceType
      ? sql`AND source_type = ${filters.sourceType}`
      : sql``;

    let chunkRows: ChunkRow[];
    let rrfScores: Map<string, number> | null = null;

    if (mode === 'vector' || (mode === 'hybrid' && this.embedder)) {
      const [queryEmbedding] = await this.embedder!.embed([text]);
      const embeddingStr = vectorToString(queryEmbedding);

      const vectorRes = await db.execute(sql`
        SELECT source_id AS id,
               1 - (embedding <=> ${embeddingStr}::vector) AS score
        FROM knowledge_chunks
        WHERE namespace = ${namespace}
          AND embedding IS NOT NULL
          ${filterClause}
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${limit * 2}
      `);

      const vectorRanked = (vectorRes.rows as Array<{ id: string; score: number }>)
        .map((r, idx) => ({ id: r.id, score: Number(r.score) }));

      if (mode === 'vector') {
        // Vector-only: fetch full rows for top results
        const ids = vectorRanked.slice(0, limit).map(r => r.id);
        if (ids.length === 0) return [];
        const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause);
        const scoreMap = new Map(vectorRanked.map(r => [r.id, r.score]));
        return this._toResults(rows, scoreMap, ids);
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
          ${filterClause}
        ORDER BY score DESC
        LIMIT ${limit * 2}
      `);

      const lexicalRanked = (lexicalRes.rows as Array<{ id: string; score: number }>)
        .map(r => ({ id: r.id, score: Number(r.score) }));

      const fused = reciprocalRankFusion(vectorRanked, lexicalRanked).slice(0, limit);
      rrfScores = new Map(fused.map(r => [r.id, r.score]));

      const ids = fused.map(r => r.id);
      if (ids.length === 0) return [];
      const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause);
      return this._toResults(rows, rrfScores, ids);
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
        ${filterClause}
      ORDER BY score DESC
      LIMIT ${limit}
    `);

    const lexRanked = (lexOnlyRes.rows as Array<{ id: string; score: number }>)
      .map(r => ({ id: r.id, score: Number(r.score) }));

    if (lexRanked.length === 0) return [];
    const ids = lexRanked.map(r => r.id);
    const rows = await this._fetchBySourceIds(db, namespace, ids, filterClause);
    const scoreMap = new Map(lexRanked.map(r => [r.id, r.score]));
    return this._toResults(rows, scoreMap, ids);
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
  ): Promise<ChunkRow[]> {
    if (sourceIds.length === 0) return [];
    const inList = sql.join(sourceIds.map(id => sql`${id}`), sql`, `);
    const res = await db.execute(sql`
      SELECT source_id, namespace, corpus, source_type, source_path, source_url, content, metadata
      FROM knowledge_chunks
      WHERE namespace = ${namespace}
        AND source_id IN (${inList})
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
