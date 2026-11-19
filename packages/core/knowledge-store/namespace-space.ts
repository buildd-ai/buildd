/**
 * The embedding space a knowledge namespace is stored in
 * (docs/specs/local-runner-provider.md §5.3): one `knowledge_namespaces` row
 * per namespace naming its model, its size and the `knowledge_chunks` column
 * that size lives in.
 *
 * - D-1: a namespace has one space at a time; the first vector write creates
 *   the row from the embedder that wrote it.
 * - D-3: when the embedder the team now picks differs from the row (model or
 *   size), the row moves to the new space and `reembed_status` goes `pending`.
 *   Rows embedded under the old space stay reachable through the lexical leg
 *   only until re-embedded; vectors are never cast or copied.
 * - D-5: a namespace with no row is recorded on first touch from whatever
 *   embedder touches it (the Voyage default at 1024 for every team that never
 *   picked), so nothing is backfilled over `knowledge_chunks`.
 *
 * Every write is one guarded statement: `INSERT … ON CONFLICT DO NOTHING` for
 * the first row and an `UPDATE … WHERE (model, dimensions) differ` for a move,
 * so two concurrent touches agree on one space (never `db.transaction()`).
 * Reads are cached per process for a minute, keyed on the embedder they were
 * resolved for, so the default path costs no extra query per search.
 */
import { sql, type SQL } from 'drizzle-orm';
import { vectorColumnForDimensions, type ReembedStatus, type VectorColumn } from '@buildd/shared';

export type SpaceExec = (q: SQL) => Promise<{ rows?: unknown[] }>;

/** What a namespace's row says about its vectors. */
export interface NamespaceSpace {
  namespace: string;
  model: string;
  dimensions: number;
  vectorColumn: VectorColumn;
  provider: string | null;
  reembedStatus: ReembedStatus;
  reembedTotal: number;
  reembedDone: number;
}

/** The embedder a touch happens with: its model, its size and (when known) the provider id. */
export interface SpaceEmbedder {
  model: string;
  dimensions: number;
  provider?: string | null;
}

export type SpaceResolution =
  /** The namespace's space, matching the embedder (created or moved on this touch if needed). */
  | { kind: 'ok'; space: NamespaceSpace; created: boolean; moved: boolean }
  /** The embedder's size has no column: nothing can be stored or searched for it. */
  | { kind: 'unsupported'; dimensions: number; space: NamespaceSpace | null }
  /** The row could not be brought to the embedder's space (a concurrent move won): the vector leg must not run. */
  | { kind: 'mismatch'; space: NamespaceSpace; embedder: SpaceEmbedder };

type J = Record<string, unknown>;
const rowsOf = (r: { rows?: unknown[] }) => (r.rows ?? []) as J[];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 5_000;
const cache = new Map<string, { at: number; space: NamespaceSpace }>();

/** Drop cached spaces. Tests only. */
export function resetNamespaceSpaceCache(): void {
  cache.clear();
}

function rowToSpace(r: J): NamespaceSpace {
  return {
    namespace: String(r.namespace),
    model: String(r.embedding_model),
    dimensions: Number(r.dimensions),
    vectorColumn: String(r.vector_column) as VectorColumn,
    provider: r.embedding_provider == null ? null : String(r.embedding_provider),
    reembedStatus: String(r.reembed_status) as ReembedStatus,
    reembedTotal: Number(r.reembed_total ?? 0),
    reembedDone: Number(r.reembed_done ?? 0),
  };
}

const SELECT_COLS = sql`namespace, embedding_provider, embedding_model, dimensions, vector_column, reembed_status, reembed_total, reembed_done`;

/** The stored row, or null. Never cached: this is what the resolver and the re-embed driver read fresh. */
export async function readNamespaceSpace(namespace: string, exec: SpaceExec): Promise<NamespaceSpace | null> {
  const rows = rowsOf(await exec(sql`-- knowledge:namespace_read
SELECT ${SELECT_COLS} FROM knowledge_namespaces WHERE namespace = ${namespace}`));
  return rows[0] ? rowToSpace(rows[0]) : null;
}

const same = (space: NamespaceSpace, e: SpaceEmbedder) => space.model === e.model && space.dimensions === e.dimensions;

/**
 * The namespace's space for this embedder: read, created (D-5 / D-1) or moved
 * (D-3) in that order, each as one guarded statement. A size with no column is
 * `unsupported`; a row another touch moved elsewhere at the same moment is
 * `mismatch`, and the caller runs lexical-only rather than mixing vectors.
 */
export async function resolveNamespaceSpace(namespace: string, embedder: SpaceEmbedder, exec: SpaceExec): Promise<SpaceResolution> {
  const column = vectorColumnForDimensions(embedder.dimensions);
  const now = Date.now();
  const cached = cache.get(namespace);
  if (cached && now - cached.at < CACHE_TTL_MS && same(cached.space, embedder)) {
    return { kind: 'ok', space: cached.space, created: false, moved: false };
  }

  let space = await readNamespaceSpace(namespace, exec);
  if (!column) return { kind: 'unsupported', dimensions: embedder.dimensions, space };

  let created = false;
  let moved = false;
  if (!space) {
    const [owner = '', corpus = ''] = namespace.split(':');
    const teamId = UUID_RE.test(owner)
      ? sql`coalesce((SELECT w.team_id FROM workspaces w WHERE w.id = ${owner}::uuid), (SELECT t.id FROM teams t WHERE t.id = ${owner}::uuid))`
      : sql`NULL::uuid`;
    const rows = rowsOf(await exec(sql`-- knowledge:namespace_create
INSERT INTO knowledge_namespaces (namespace, team_id, corpus, embedding_provider, embedding_model, dimensions, vector_column)
VALUES (${namespace}, ${teamId}, ${corpus}, ${embedder.provider ?? null}, ${embedder.model}, ${embedder.dimensions}::int, ${column})
ON CONFLICT (namespace) DO NOTHING
RETURNING ${SELECT_COLS}`));
    if (rows[0]) {
      space = rowToSpace(rows[0]);
      created = true;
    } else {
      space = await readNamespaceSpace(namespace, exec);
      if (!space) {
        // The insert found a row and the re-read found none: a database that
        // does not answer RETURNING (a stub). Nothing can have moved the
        // namespace elsewhere, so the embedder's own space is the answer.
        space = { namespace, model: embedder.model, dimensions: embedder.dimensions, vectorColumn: column, provider: embedder.provider ?? null, reembedStatus: 'none', reembedTotal: 0, reembedDone: 0 };
        created = true;
      }
    }
  }

  if (!same(space, embedder)) {
    // D-3: the pick changed. The namespace moves to the new space now and its
    // rows are re-embedded by the job stream; until then they are lexical-only.
    const rows = rowsOf(await exec(sql`-- knowledge:namespace_move
UPDATE knowledge_namespaces
SET embedding_provider = ${embedder.provider ?? null}, embedding_model = ${embedder.model}, dimensions = ${embedder.dimensions}::int, vector_column = ${column},
    reembed_status = 'pending',
    reembed_total = (SELECT count(*) FROM knowledge_chunks c WHERE c.namespace = ${namespace} AND c.is_current = true),
    reembed_done = 0, reembed_started_at = NULL, reembed_finished_at = NULL, updated_at = now()
WHERE namespace = ${namespace} AND (embedding_model <> ${embedder.model} OR dimensions <> ${embedder.dimensions}::int)
RETURNING ${SELECT_COLS}`));
    if (rows[0]) {
      space = rowToSpace(rows[0]);
      moved = true;
    } else {
      space = (await readNamespaceSpace(namespace, exec)) ?? space;
      if (!same(space, embedder)) {
        cache.delete(namespace);
        return { kind: 'mismatch', space, embedder };
      }
    }
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(namespace, { at: now, space });
  return { kind: 'ok', space, created, moved };
}

// ── Re-embed progress (D-6; the walker itself is PgVectorStore.reembedNamespace) ──

/** Mark a namespace's re-embed as running (first batch) or finished. One UPDATE each, idempotent. */
export async function markReembed(namespace: string, status: 'running' | 'done' | 'failed', exec: SpaceExec, done?: number): Promise<void> {
  cache.delete(namespace);
  if (status === 'running') {
    await exec(sql`-- knowledge:namespace_reembed_running
UPDATE knowledge_namespaces
SET reembed_status = 'running', reembed_started_at = coalesce(reembed_started_at, now()),
    reembed_done = reembed_done + ${done ?? 0}::int, updated_at = now()
WHERE namespace = ${namespace} AND reembed_status IN ('pending', 'running', 'failed')`);
    return;
  }
  await exec(sql`-- knowledge:namespace_reembed_end
UPDATE knowledge_namespaces
SET reembed_status = ${status}, reembed_finished_at = now(), updated_at = now()
WHERE namespace = ${namespace} AND reembed_status IN ('pending', 'running')`);
}

/** Namespaces with a re-embed owed, oldest first: what a driver walks per tick. */
export async function listNamespacesToReembed(exec: SpaceExec, limit = 20): Promise<NamespaceSpace[]> {
  const rows = rowsOf(await exec(sql`-- knowledge:namespaces_pending
SELECT ${SELECT_COLS} FROM knowledge_namespaces
WHERE reembed_status IN ('pending', 'running')
ORDER BY updated_at
LIMIT ${Math.max(1, Math.min(200, limit))}::int`));
  return rows.map(rowToSpace);
}
