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
import { and, asc, eq, lt, or, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { evidenceObjects, tasks, workspaces } from '@buildd/core/db/schema';
import { chunkEvidenceLog, type EvidenceChunk } from '@buildd/core/evidence-chunker';
import { createSecretRedactor } from '@buildd/core/redaction';
import type { KnowledgeStore, UpsertChunk } from '@buildd/core/knowledge-store';
import { openEvidenceObject, type EvidenceObjectRow } from './evidence-read';
import { abandonPendingEvidence, confirmEvidenceUpload, type EvidenceConfirmResult } from './evidence-confirm';
import { extractFailureDigest } from './ci-failure-digest';

/** A `failed` row is retried once this long has passed since its last attempt. */
export const EVIDENCE_INDEX_RETRY_AFTER_MS = 60 * 60 * 1000;
/**
 * Reaper grace. A runner confirms its own upload right after the PUT
 * (`POST /api/workers/[id]/evidence/[evidenceId]/confirm`), and the presigned
 * PUT expires after 15 minutes. A row still `pending` after this long lost its
 * confirm (an older runner, a crash, a network error), so the sweep settles it
 * with the same check the confirm route runs.
 */
export const PENDING_UPLOAD_GRACE_MS = 60 * 60 * 1000;
/**
 * A pending row whose bucket still cannot be checked this long after upload
 * (revoked credential, deleted bucket) is settled `unreadable` instead of being
 * retried forever. Past retention for buildd_default, so nothing is lost.
 */
export const PENDING_UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Stored rows indexed per sweep run; the rest wait for the next tick. */
export const EVIDENCE_INDEX_BATCH = 25;
/**
 * Pending rows reaped per sweep run. A budget of its own, taken after the
 * stored rows, so stuck uploads can never crowd indexing out.
 */
export const EVIDENCE_REAP_BATCH = 5;
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
};

export interface EvidenceIndexerDeps {
  /** Stored rows to index (evidenceIndexCandidateWhere). */
  loadCandidates(limit: number, now: Date): Promise<EvidenceIndexCandidate[]>;
  /** Pending rows past the confirm grace (evidenceReapCandidateWhere). */
  loadReapCandidates(limit: number, now: Date): Promise<EvidenceIndexCandidate[]>;
  /** Settle a stale `pending` row (HEAD on its backend); see evidence-confirm.ts. */
  confirmUpload(row: EvidenceObjectRow): Promise<EvidenceConfirmResult>;
  /** Give up on a pending row past PENDING_UPLOAD_MAX_AGE_MS: settle it unreadable. */
  abandonUpload(row: EvidenceObjectRow, reason: string): Promise<EvidenceConfirmResult>;
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

/** Stored rows the sweep indexes. Exported so the predicate can be asserted as rendered SQL. */
export function evidenceIndexCandidateWhere(now: Date): SQL {
  return and(
    eq(evidenceObjects.uploadState, 'stored'),
    or(
      eq(evidenceObjects.indexState, 'queued'),
      and(
        eq(evidenceObjects.indexState, 'failed'),
        lt(evidenceObjects.updatedAt, new Date(now.getTime() - EVIDENCE_INDEX_RETRY_AFTER_MS)),
      ),
    ),
  )!;
}

/**
 * Pending rows the reaper settles: past the confirm grace, in any index state
 * (so a sensitive, `skipped` row is settled too; it is still never indexed).
 */
export function evidenceReapCandidateWhere(now: Date): SQL {
  return and(
    eq(evidenceObjects.uploadState, 'pending'),
    lt(evidenceObjects.createdAt, new Date(now.getTime() - PENDING_UPLOAD_GRACE_MS)),
  )!;
}

export const evidenceNamespace = (workspaceId: string) => `${workspaceId}:evidence`;
export const evidenceSourcePath = (evidenceId: string) => `evidence/${evidenceId}`;
const short = (id: string) => id.slice(0, 8);

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
  const redact = createSecretRedactor([]);
  const redactedTitle = c.taskTitle ? redact(c.taskTitle).slice(0, 160) : null;
  const lineage = [
    `task ${short(row.taskId)}`,
    row.rootTaskId !== row.taskId ? `root ${short(row.rootTaskId)}` : null,
    row.prNumber ? `PR #${row.prNumber}` : null,
    redactedTitle ? `"${redactedTitle}"` : null,
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
  let { row } = c;
  const ns = evidenceNamespace(row.workspaceId);
  const clearOld = () => deps.store.deleteBySource?.(ns, { sourcePath: evidenceSourcePath(row.id), sourceType: EVIDENCE_SOURCE_TYPE });
  const record = async (fields: EvidenceRowUpdate) => {
    try { await deps.updateRow(row.id, fields); } catch (err) {
      console.warn(`[evidence-index] could not record ${fields.indexState} for ${row.id}: ${message(err)}`);
    }
  };

  if (row.uploadState === 'pending') {
    let confirmed: EvidenceConfirmResult;
    try {
      confirmed = await deps.confirmUpload(row);
    } catch (err) {
      confirmed = { uploadState: 'pending', bytes: row.bytes, changed: false, reason: message(err) };
    }
    if (confirmed.uploadState === 'pending') {
      const age = deps.now().getTime() - new Date(row.createdAt).getTime();
      if (age > PENDING_UPLOAD_MAX_AGE_MS) {
        let abandoned: EvidenceConfirmResult | null = null;
        try {
          abandoned = await deps.abandonUpload(row, `the bucket could not be checked for ${Math.round(PENDING_UPLOAD_MAX_AGE_MS / 86_400_000)} days: ${confirmed.reason ?? 'unknown error'}`.slice(0, 300));
        } catch { /* fall through to a re-stamp */ }
        if (abandoned && abandoned.uploadState !== 'pending') {
          return { outcome: 'skipped', chunks: 0, error: abandoned.reason ?? `upload ${abandoned.uploadState}` };
        }
      }
      // Re-stamp so it moves to the back of the line; the index state is kept.
      await record({ indexState: row.indexState === 'skipped' ? 'skipped' : 'queued' });
      return { outcome: 'deferred', chunks: 0, ...(confirmed.reason ? { error: confirmed.reason } : {}) };
    }
    if (confirmed.uploadState !== 'stored') {
      // confirmEvidenceUpload already wrote the row (failed/unreadable, index skipped).
      return { outcome: 'skipped', chunks: 0, error: confirmed.reason ?? `upload ${confirmed.uploadState}` };
    }
    row = { ...row, uploadState: 'stored', bytes: confirmed.bytes };
    if (row.indexState === 'skipped') {
      // Skipped at upload (a sensitive workspace then) stays skipped, whatever the
      // workspace's class is now: the object is never opened for indexing.
      return { outcome: 'skipped', chunks: 0 };
    }
  }

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
    await record({ indexState: 'indexed' });
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
  opts: { limit?: number; reapLimit?: number } = {},
): Promise<EvidenceIndexSweepResult> {
  const now = deps.now();
  // Stored rows first, on the full budget; then the reaper on its own, smaller
  // one. A pile of unreachable pending rows therefore cannot delay indexing.
  const rows = await deps.loadCandidates(opts.limit ?? EVIDENCE_INDEX_BATCH, now);
  const out: EvidenceIndexSweepResult = { considered: rows.length, indexed: 0, skipped: 0, failed: 0, deferred: 0, chunks: 0 };
  for (const c of rows) {
    const r = await indexEvidenceObject(c, deps);
    out[r.outcome]++;
    out.chunks += r.chunks;
    if (r.error && r.outcome === 'failed') console.warn(`[evidence-index] ${c.row.id}: ${r.error}`);
  }
  let reap: EvidenceIndexCandidate[] = [];
  try {
    reap = await deps.loadReapCandidates(opts.reapLimit ?? EVIDENCE_REAP_BATCH, now);
  } catch (err) {
    console.warn(`[evidence-index] could not load pending rows to reap: ${message(err)}`);
  }
  out.considered += reap.length;
  for (const c of reap) {
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

async function loadWhere(where: SQL, limit: number): Promise<EvidenceIndexCandidate[]> {
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
    .where(where)
    .orderBy(asc(evidenceObjects.updatedAt))
    .limit(limit);
  return rows.map(r => ({
    row: r.row,
    dataClass: r.dataClass ?? null,
    taskTitle: r.taskTitle ?? null,
    taskSummary: summaryOf(r.taskResult),
  }));
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
    loadCandidates: (limit, now) => loadWhere(evidenceIndexCandidateWhere(now), limit),
    loadReapCandidates: (limit, now) => loadWhere(evidenceReapCandidateWhere(now), limit),
    confirmUpload: row => confirmEvidenceUpload(row),
    abandonUpload: (row, reason) => abandonPendingEvidence(row, reason),
    openObject: row => openEvidenceObject(row),
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
