/**
 * Evidence indexer: feeds the `{workspaceId}:evidence` knowledge corpus from
 * stored evidence objects (docs/specs/byo-evidence-storage.md, "The `evidence`
 * corpus", build breakdown item 5).
 *
 * Not `knowledge_ingest_jobs`: that table is repo-file shaped. Like the
 * task/pr/artifact corpora this is a direct, best-effort `knowledgeStore.upsert`,
 * and durability comes from `evidence_objects.index_state`: the sweep
 * (`/api/cron/evidence-index`) re-drives every `queued` row and every `failed`
 * row past a backoff, so an index that silently never happened is a row a
 * reader can find.
 *
 * Per object:
 *   - a sensitive workspace is never indexed: `index_state = skipped`, nothing
 *     reaches the embedder, and any chunks from before the workspace turned
 *     sensitive are removed (invariant 7);
 *   - the body is read through the same reader the read routes use, then
 *     `chunkEvidenceLog` keeps only the error-bearing signal and redacts again;
 *   - the object's earlier chunks are cleared, then its new ones written with
 *     `source_id = <evidenceId>#<n>` and lineage metadata.
 *
 * Nothing here changes a task or worker status (invariant 5).
 */
import { and, asc, eq, inArray, lt, or, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { evidenceObjects, tasks, workspaces } from '@buildd/core/db/schema';
import { chunkEvidenceLog, type EvidenceChunk } from '@buildd/core/evidence-chunker';
import type { KnowledgeStore, UpsertChunk } from '@buildd/core/knowledge-store';
import { openEvidenceObject, type EvidenceObjectRow } from './evidence-read';
import { extractFailureDigest } from './ci-failure-digest';

/** A `failed` row is retried once this long has passed since its last attempt. */
export const EVIDENCE_INDEX_RETRY_AFTER_MS = 60 * 60 * 1000;
/**
 * A runner's presigned PUT is valid for 15 minutes and nothing confirms it, so a
 * `pending` row whose object is still missing after this long never arrived.
 */
export const PENDING_UPLOAD_GRACE_MS = 60 * 60 * 1000;
/** Rows per sweep run; the rest wait for the next tick. */
export const EVIDENCE_INDEX_BATCH = 25;
/** Most decoded text read from one object. Longer bodies keep their tail. */
export const MAX_INDEX_TEXT_BYTES = 16 * 1024 * 1024;

export const EVIDENCE_SOURCE_TYPE = 'evidence';

export interface EvidenceIndexCandidate {
  row: EvidenceObjectRow;
  dataClass: string | null;
  taskTitle: string | null;
  taskSummary: string | null;
}

export type EvidenceRowUpdate = {
  /** `queued` only re-stamps updated_at, so a deferred row goes to the back of the line. */
  indexState: 'indexed' | 'skipped' | 'failed' | 'queued';
  uploadState?: 'stored' | 'failed';
};

export interface EvidenceIndexerDeps {
  loadCandidates(limit: number, now: Date): Promise<EvidenceIndexCandidate[]>;
  openObject(row: EvidenceObjectRow): Promise<AsyncIterable<Uint8Array>>;
  store: Pick<KnowledgeStore, 'upsert'> & Partial<Pick<KnowledgeStore, 'deleteBySource'>>;
  updateRow(id: string, fields: EvidenceRowUpdate): Promise<void>;
  now(): Date;
}

export type EvidenceIndexOutcome = 'indexed' | 'skipped' | 'failed' | 'deferred';

export interface EvidenceIndexResult {
  outcome: EvidenceIndexOutcome;
  chunks: number;
  error?: string;
}

export interface EvidenceIndexSweepResult {
  considered: number;
  indexed: number;
  skipped: number;
  failed: number;
  deferred: number;
  chunks: number;
}

/** Rows the sweep picks up. Exported so the predicate can be asserted as rendered SQL. */
export function evidenceIndexCandidateWhere(now: Date): SQL {
  return and(
    inArray(evidenceObjects.uploadState, ['pending', 'stored']),
    or(
      eq(evidenceObjects.indexState, 'queued'),
      and(
        eq(evidenceObjects.indexState, 'failed'),
        lt(evidenceObjects.updatedAt, new Date(now.getTime() - EVIDENCE_INDEX_RETRY_AFTER_MS)),
      ),
    ),
  )!;
}

export const evidenceNamespace = (workspaceId: string) => `${workspaceId}:evidence`;
export const evidenceSourcePath = (evidenceId: string) => `evidence/${evidenceId}`;
const short = (id: string) => id.slice(0, 8);

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

async function readText(src: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const c of src) {
    const b = Buffer.from(c);
    parts.push(b);
    total += b.length;
    // Keep the tail: the end of a log is where a failure is reported.
    while (total > MAX_INDEX_TEXT_BYTES && parts.length > 1) total -= parts.shift()!.length;
  }
  let buf = Buffer.concat(parts);
  if (buf.length > MAX_INDEX_TEXT_BYTES) buf = buf.subarray(buf.length - MAX_INDEX_TEXT_BYTES);
  return buf.toString('utf8');
}

function toUpsertChunks(c: EvidenceIndexCandidate, chunks: EvidenceChunk[]): UpsertChunk[] {
  const { row } = c;
  const lineage = [
    `task ${short(row.taskId)}`,
    row.rootTaskId !== row.taskId ? `root ${short(row.rootTaskId)}` : null,
    row.prNumber ? `PR #${row.prNumber}` : null,
    c.taskTitle ? `"${c.taskTitle.slice(0, 160)}"` : null,
  ].filter(Boolean).join(' · ');

  return chunks.map((chunk, i) => {
    const isSummary = chunk.errorClass === 'summary';
    // A summary is the same for every object of a task: its header names no
    // kind, so content dedup keeps one copy per namespace.
    const header = isSummary ? `evidence summary · ${lineage}` : `evidence ${row.kind} · ${lineage}`;
    const labels = [
      chunk.testName ? `test: ${chunk.testName}` : null,
      chunk.file ? `file: ${chunk.file}` : null,
    ].filter(Boolean).join('\n');
    return {
      id: `${row.id}#${i}`,
      content: [header, labels, chunk.content].filter(Boolean).join('\n'),
      sourceType: EVIDENCE_SOURCE_TYPE,
      sourcePath: evidenceSourcePath(row.id),
      sourceUrl: `/app/tasks/${row.taskId}`,
      sourceTs: row.createdAt ? new Date(row.createdAt) : null,
      metadata: {
        evidenceId: row.id,
        taskId: row.taskId,
        rootTaskId: row.rootTaskId,
        prNumber: row.prNumber ?? null,
        kind: row.kind,
        errorClass: chunk.errorClass,
        ...(chunk.testName ? { testName: chunk.testName } : {}),
        ...(chunk.file ? { file: chunk.file } : {}),
      },
      ...(isSummary ? { contentDedup: true } : {}),
    };
  });
}

/** Index one object. Never throws; the outcome is also written to the row. */
export async function indexEvidenceObject(
  c: EvidenceIndexCandidate,
  deps: EvidenceIndexerDeps,
): Promise<EvidenceIndexResult> {
  const { row } = c;
  const ns = evidenceNamespace(row.workspaceId);
  const clearOld = () => deps.store.deleteBySource?.(ns, { sourcePath: evidenceSourcePath(row.id), sourceType: EVIDENCE_SOURCE_TYPE });
  const record = async (fields: EvidenceRowUpdate) => {
    try { await deps.updateRow(row.id, fields); } catch (err) {
      console.warn(`[evidence-index] could not record ${fields.indexState} for ${row.id}: ${message(err)}`);
    }
  };

  if (c.dataClass === 'sensitive') {
    // Nothing is sent to the embedder; purge whatever was indexed before.
    try { await clearOld(); } catch { /* the skip still stands */ }
    await record({ indexState: 'skipped' });
    return { outcome: 'skipped', chunks: 0 };
  }

  let text: string;
  try {
    text = await readText(await deps.openObject(row));
  } catch (err) {
    if (row.uploadState === 'pending' && statusOf(err) === 410) {
      const age = deps.now().getTime() - new Date(row.createdAt).getTime();
      if (age < PENDING_UPLOAD_GRACE_MS) {
        // Still in flight, maybe. Re-stamp it so a burst of these cannot hold
        // the front of the batch and starve rows that are ready.
        await record({ indexState: 'queued' });
        return { outcome: 'deferred', chunks: 0 };
      }
      await record({ indexState: 'skipped', uploadState: 'failed' });
      return { outcome: 'skipped', chunks: 0, error: 'upload never arrived' };
    }
    const error = message(err);
    await record({ indexState: 'failed' });
    return { outcome: 'failed', chunks: 0, error };
  }

  try {
    const chunks = chunkEvidenceLog({
      text,
      kind: row.kind,
      digest: row.kind === 'ci_job_log' ? extractFailureDigest(text) : null,
      summary: c.taskSummary,
    });
    const upserts = toUpsertChunks(c, chunks);
    await clearOld();
    if (upserts.length > 0) await deps.store.upsert(ns, upserts);
    await record(row.uploadState === 'pending'
      ? { indexState: 'indexed', uploadState: 'stored' }
      : { indexState: 'indexed' });
    return { outcome: 'indexed', chunks: upserts.length };
  } catch (err) {
    const error = message(err);
    await record({ indexState: 'failed' });
    return { outcome: 'failed', chunks: 0, error };
  }
}

/** One sweep: index up to `limit` candidate rows, sequentially (the embedder is rate-limited). */
export async function runEvidenceIndexSweep(
  deps: EvidenceIndexerDeps = defaultEvidenceIndexerDeps(),
  opts: { limit?: number } = {},
): Promise<EvidenceIndexSweepResult> {
  const now = deps.now();
  const rows = await deps.loadCandidates(opts.limit ?? EVIDENCE_INDEX_BATCH, now);
  const out: EvidenceIndexSweepResult = { considered: rows.length, indexed: 0, skipped: 0, failed: 0, deferred: 0, chunks: 0 };
  for (const c of rows) {
    const r = await indexEvidenceObject(c, deps);
    out[r.outcome]++;
    out.chunks += r.chunks;
    if (r.error && r.outcome === 'failed') console.warn(`[evidence-index] ${c.row.id}: ${r.error}`);
  }
  return out;
}

// ── Defaults ───────────────────────────────────────────────────────────────

function summaryOf(result: unknown): string | null {
  const s = (result as { summary?: unknown } | null)?.summary;
  return typeof s === 'string' && s.trim() ? s : null;
}

export function defaultEvidenceIndexerDeps(store?: EvidenceIndexerDeps['store']): EvidenceIndexerDeps {
  let lazyStore = store;
  const getStore = async () => {
    if (!lazyStore) {
      const { PgVectorStore, getVoyageEmbedder } = await import('@buildd/core/knowledge-store');
      // Same default embedder the query side uses; lexical-only when none is configured.
      lazyStore = new PgVectorStore(getVoyageEmbedder());
    }
    return lazyStore;
  };
  return {
    async loadCandidates(limit, now) {
      const rows = await db
        .select({
          row: evidenceObjects,
          dataClass: workspaces.dataClass,
          taskTitle: tasks.title,
          taskResult: tasks.result,
        })
        .from(evidenceObjects)
        .innerJoin(workspaces, eq(workspaces.id, evidenceObjects.workspaceId))
        .leftJoin(tasks, eq(tasks.id, evidenceObjects.taskId))
        .where(evidenceIndexCandidateWhere(now))
        .orderBy(asc(evidenceObjects.updatedAt))
        .limit(limit);
      return rows.map(r => ({
        row: r.row,
        dataClass: r.dataClass ?? null,
        taskTitle: r.taskTitle ?? null,
        taskSummary: summaryOf(r.taskResult),
      }));
    },
    openObject: row => openEvidenceObject(row, { acceptPending: true }),
    store: {
      upsert: async (ns, chunks) => (await getStore()).upsert(ns, chunks),
      deleteBySource: async (ns, sel) => (await getStore()).deleteBySource?.(ns, sel),
    },
    async updateRow(id, fields) {
      await db.update(evidenceObjects)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(evidenceObjects.id, id));
    },
    now: () => new Date(),
  };
}
