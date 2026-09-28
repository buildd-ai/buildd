/**
 * Reconcile pass: re-mirror memory rows the `{teamId}:memory` index is missing.
 *
 * Every write path mirrors through ./memory-write, but a mirror can fail (index
 * down, embedder error) and rows written before the dashboard and digest paths
 * mirrored were never indexed at all. Without this, `recall` cannot see them.
 *
 * Bounded: at most `MEMORY_RECONCILE_MAX_ROWS` rows per run, newest first, so a
 * backlog drains across runs. It rides an existing cron (feedback-digest) and
 * adds no schedule of its own.
 */
import { sql, type SQL } from 'drizzle-orm';
import { mirrorMemoryToIndex, type IndexableMemory } from './memory-write';
import type { KnowledgeStore } from './knowledge-store/types';

/** Upper bound on rows re-mirrored per run. Each one can cost an embedding call. */
export const MEMORY_RECONCILE_MAX_ROWS = 25;

function clampLimit(limit: number | undefined): number {
  const n = Math.floor(limit ?? MEMORY_RECONCILE_MAX_ROWS);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MEMORY_RECONCILE_MAX_ROWS);
}

/**
 * Memory rows with no chunk in their own team's memory namespace. The join
 * key matches how writes are keyed: namespace `{team_id}:memory`, source_id =
 * memory id (served by the (namespace, source_id) unique index).
 */
export function unindexedMemoriesQuery(limit: number): SQL {
  return sql`
    SELECT m.id, m.team_id, m.type, m.title, m.content, m.project, m.tags, m.files
    FROM memories m
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_chunks kc
      WHERE kc.namespace = m.team_id::text || ':memory'
        AND kc.source_id = m.id::text
    )
    ORDER BY m.updated_at DESC
    LIMIT ${clampLimit(limit)}
  `;
}

type UnindexedRow = {
  id: string; team_id: string; type: string; title: string; content: string;
  project: string | null; tags: string[] | null; files: string[] | null;
};

async function findUnindexedFromDb(limit: number): Promise<IndexableMemory[]> {
  const { db } = await import('./db');
  const res = await db.execute(unindexedMemoriesQuery(limit));
  return (res.rows as UnindexedRow[]).map(r => ({
    id: r.id,
    teamId: r.team_id,
    type: r.type as IndexableMemory['type'],
    title: r.title,
    content: r.content,
    project: r.project,
    tags: r.tags ?? [],
    files: r.files ?? [],
  }));
}

export interface ReconcileResult {
  scanned: number;
  mirrored: number;
  failed: number;
}

/**
 * Re-mirror up to `limit` (capped) unindexed memory rows. One upsert per row,
 * so one bad row does not block the rest. Failures are logged and counted by
 * the write helper under `via=reconcile`.
 */
export async function reconcileMemoryIndex(opts: {
  knowledgeStore: KnowledgeStore;
  limit?: number;
  /** Injected in tests; defaults to the DB query above. */
  findUnindexed?: (limit: number) => Promise<IndexableMemory[]>;
}): Promise<ReconcileResult> {
  const limit = clampLimit(opts.limit);
  const rows = await (opts.findUnindexed ?? findUnindexedFromDb)(limit);
  let mirrored = 0;
  let failed = 0;
  for (const m of rows.slice(0, limit)) {
    const out = await mirrorMemoryToIndex(opts.knowledgeStore, m.teamId, m, { via: 'reconcile' });
    if (out.mirrored) mirrored++;
    else failed++;
  }
  return { scanned: rows.length, mirrored, failed };
}
