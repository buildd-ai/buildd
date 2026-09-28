/**
 * Reconcile pass: bring the `{teamId}:memory` index back in line with the
 * memories table.
 *
 * Every write path mirrors through ./memory-write, but a mirror can fail (index
 * down, embedder error), and rows written before the dashboard and digest paths
 * mirrored were never indexed at all. Without this, `recall` cannot see them,
 * or keeps serving text the row no longer holds. Per run it:
 *
 * - mirrors live rows with no chunk, and re-mirrors live rows whose chunk is
 *   stale (content, title, project, type, tags or files differ from the row);
 * - flips the chunk of a row recorded as superseded (`memories.superseded_by`)
 *   to not current, so a replaced memory is never indexed as current. A
 *   superseded row is never embedded: with no chunk there is nothing to fix,
 *   and a stale chunk only needs flipping;
 * - leaves alone rows with no project and rows under a key that a sensitive
 *   workspace in the team resolves to (no read can serve them);
 * - counts failed attempts on the row; a row that keeps failing sinks behind
 *   fresh ones and drops out at `MEMORY_RECONCILE_MAX_ATTEMPTS`.
 *
 * Bounded at `MEMORY_RECONCILE_MAX_ROWS` rows per run. It rides an existing cron
 * (feedback-digest) and adds no schedule of its own.
 */
import { sql, type SQL } from 'drizzle-orm';
import { mirrorMemoryToIndex, type IndexableMemory } from './memory-write';
import { workspaceProjectKey } from './project-scope';
import type { KnowledgeStore } from './knowledge-store/types';

/** Upper bound on rows handled per run. Each one can cost an embedding call. */
export const MEMORY_RECONCILE_MAX_ROWS = 25;

/** Failed attempts after which a row is no longer retried. */
export const MEMORY_RECONCILE_MAX_ATTEMPTS = 5;

function clampLimit(limit: number | undefined): number {
  const n = Math.floor(limit ?? MEMORY_RECONCILE_MAX_ROWS);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MEMORY_RECONCILE_MAX_ROWS);
}

/** Why a row was picked. `superseded`: the chunk is current but the row was replaced. */
export type ChunkState = 'missing' | 'stale' | 'superseded';

export interface ReconcileCandidate extends IndexableMemory {
  teamId: string;
  supersededBy: string | null;
  indexFailures: number;
  chunkState: ChunkState;
}

/** A (team, project key) pair no memory read may serve. */
export type ExcludedKey = { teamId: string; project: string };

/** The canonical memory key of each sensitive workspace, per team. */
export function sensitiveMemoryKeys(
  sensitive: ReadonlyArray<{ teamId: string; repo?: string | null; name?: string | null }>,
): ExcludedKey[] {
  const out: ExcludedKey[] = [];
  for (const w of sensitive) {
    const project = workspaceProjectKey(w.repo, w.name);
    if (project) out.push({ teamId: w.teamId, project });
  }
  return out;
}

/**
 * Rows whose chunk is missing, stale, or current despite the row being
 * superseded. The join key matches how writes are keyed: namespace
 * `{team_id}:memory`, source_id = memory id.
 */
export function reconcileCandidatesQuery(limit: number, excluded: readonly ExcludedKey[]): SQL {
  const stale = sql`(
    kc.content IS DISTINCT FROM m.content
    OR kc.lexical_text IS DISTINCT FROM (m.title || E'\\n\\n' || m.content)
    OR kc.metadata->>'project' IS DISTINCT FROM m.project
    OR kc.metadata->>'type' IS DISTINCT FROM m.type
    OR kc.metadata->'tags' IS DISTINCT FROM to_jsonb(m.tags)
    OR kc.metadata->'files' IS DISTINCT FROM to_jsonb(m.files)
  )`;
  const exclusion = excluded.length > 0
    ? sql`AND (m.team_id::text, m.project) NOT IN (${sql.join(excluded.map(k => sql`(${k.teamId}, ${k.project})`), sql`, `)})`
    : sql``;
  return sql`
    SELECT m.id, m.team_id, m.type, m.title, m.content, m.project, m.tags, m.files,
           m.superseded_by, m.index_failures,
           CASE WHEN m.superseded_by IS NOT NULL THEN 'superseded'
                WHEN kc.id IS NULL THEN 'missing'
                ELSE 'stale' END AS chunk_state
    FROM memories m
    LEFT JOIN knowledge_chunks kc
      ON kc.namespace = m.team_id::text || ':memory'
     AND kc.source_id = m.id::text
    WHERE m.project IS NOT NULL
      AND m.index_failures < ${MEMORY_RECONCILE_MAX_ATTEMPTS}
      ${exclusion}
      AND (
        (m.superseded_by IS NULL AND (kc.id IS NULL OR ${stale}))
        OR (m.superseded_by IS NOT NULL AND kc.is_current)
      )
    ORDER BY m.index_failures ASC, m.updated_at DESC
    LIMIT ${clampLimit(limit)}
  `;
}

type CandidateRow = {
  id: string; team_id: string; type: string; title: string; content: string;
  project: string | null; tags: string[] | null; files: string[] | null;
  superseded_by: string | null; index_failures: number | string | null; chunk_state: ChunkState;
};

/** DB access, injectable for tests. */
export interface ReconcileDeps {
  findCandidates(limit: number): Promise<ReconcileCandidate[]>;
  /** Mark the row's chunk not current, replaced by `supersededBy`. */
  markChunkSuperseded(teamId: string, memoryId: string, supersededBy: string): Promise<void>;
  /** Count a failed attempt, or reset the count after a success. */
  recordOutcome(memoryId: string, ok: boolean): Promise<void>;
}

async function getDb() {
  const { db } = await import('./db');
  return db;
}

const dbDeps: ReconcileDeps = {
  async findCandidates(limit) {
    const db = await getDb();
    const sensitive = await db.execute(sql`
      SELECT team_id::text AS team_id, repo, name FROM workspaces WHERE data_class = 'sensitive'
    `);
    const excluded = sensitiveMemoryKeys(
      (sensitive.rows as Array<{ team_id: string; repo: string | null; name: string | null }>)
        .map(r => ({ teamId: r.team_id, repo: r.repo, name: r.name })),
    );
    const res = await db.execute(reconcileCandidatesQuery(limit, excluded));
    return (res.rows as CandidateRow[]).map(r => ({
      id: r.id,
      teamId: r.team_id,
      type: r.type as IndexableMemory['type'],
      title: r.title,
      content: r.content,
      project: r.project,
      tags: r.tags ?? [],
      files: r.files ?? [],
      supersededBy: r.superseded_by,
      indexFailures: Number(r.index_failures ?? 0),
      chunkState: r.chunk_state,
    }));
  },
  async markChunkSuperseded(teamId, memoryId, supersededBy) {
    const db = await getDb();
    await db.execute(sql`
      UPDATE knowledge_chunks
      SET is_current = false, superseded_by = ${supersededBy}
      WHERE namespace = ${`${teamId}:memory`} AND source_id = ${memoryId}
    `);
  },
  async recordOutcome(memoryId, ok) {
    const db = await getDb();
    await db.execute(ok
      ? sql`UPDATE memories SET index_failures = 0 WHERE id = ${memoryId}`
      : sql`UPDATE memories SET index_failures = index_failures + 1 WHERE id = ${memoryId}`);
  },
};

export interface ReconcileResult {
  scanned: number;
  mirrored: number;
  superseded: number;
  failed: number;
}

/**
 * Reconcile up to `limit` (capped) rows. One upsert per row, so one bad row
 * does not block the rest. Mirror failures are logged and counted by the write
 * helper under `via=reconcile`, and recorded on the row.
 */
export async function reconcileMemoryIndex(opts: {
  knowledgeStore: KnowledgeStore;
  limit?: number;
  deps?: ReconcileDeps;
}): Promise<ReconcileResult> {
  const deps = opts.deps ?? dbDeps;
  const limit = clampLimit(opts.limit);
  const rows = (await deps.findCandidates(limit)).slice(0, limit);
  let mirrored = 0;
  let superseded = 0;
  let failed = 0;
  for (const m of rows) {
    // A replaced memory with no chunk has nothing to reconcile: embedding it
    // would only index text that no read may serve.
    if (m.supersededBy && m.chunkState === 'missing') continue;
    let ok = true;
    try {
      if (!m.supersededBy && m.chunkState !== 'superseded') {
        const out = await mirrorMemoryToIndex(opts.knowledgeStore, m.teamId, m, { via: 'reconcile' });
        ok = out.mirrored;
        if (ok) mirrored++;
      }
      if (ok && m.supersededBy) {
        await deps.markChunkSuperseded(m.teamId, m.id, m.supersededBy);
        superseded++;
      }
    } catch (err) {
      ok = false;
      console.warn(`[memory-reconcile-failed] memory=${m.id}`, err);
    }
    if (!ok) failed++;
    if (!ok || m.indexFailures > 0) await deps.recordOutcome(m.id, ok).catch(() => {});
  }
  return { scanned: rows.length, mirrored, superseded, failed };
}
