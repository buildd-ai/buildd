import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { db } from '@buildd/core/db';
import { evidenceObjects, tasks, workers } from '@buildd/core/db/schema';
import { and, eq, ne, sql } from 'drizzle-orm';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import {
  EVIDENCE_UPLOAD_EXPIRY_SECONDS,
  generateEvidenceUploadUrl,
  resolveEvidenceBackend,
  type ResolvedEvidenceBackend,
} from '@/lib/evidence-backend';
import { buildEvidenceObjectKey } from '@/lib/storage-keys';

/**
 * POST /api/workers/[id]/evidence-upload-url  {kind, seq, sizeBytes}
 *
 * Presigned PUT for one piece of run evidence (docs/specs/byo-evidence-storage.md,
 * "What gets written"). Generalises session-upload-url:
 *
 *  - Same authorization: the caller's account owns the worker and shares its team;
 *    a per-task token (cloud runner) only for the worker on its own task.
 *  - The key is derived server-side (buildEvidenceObjectKey); a body key is ignored.
 *  - The backend is resolved per workspace (workspace → team → buildd_default) and
 *    the URL is signed with that backend's client, byte length bound in, 15 min.
 *  - `max_bytes_per_task` is enforced across the task's evidence_objects (413).
 *    Failed uploads do not count; pending ones do, so they act as reservations.
 *  - A sensitive workspace may write only to a BYO backend (403 otherwise), and
 *    its objects are never indexed (index_state = skipped).
 *  - A storage or backend failure is a 424 refusal, never a 5xx (invariant 5): the
 *    runner skips quietly and the task carries on.
 *
 * On success an evidence_objects row is inserted with upload_state = pending.
 *
 * PUT contract for the caller: `PUT uploadUrl` with a body of exactly
 * `sizeBytes` bytes. Content-Length is the only signed header; SSE, when the
 * backend uses it, is carried in the URL's query string, so no other header
 * is required. Content-Type is not signed and may be anything.
 */

/** Kinds a runner may write. `ci_job_log` and `pr_diff` are server-written. */
const RUNNER_EVIDENCE_KINDS = {
  command_output: 'log',
  test_report: 'log',
  transcript: 'jsonl',
} as const;
type RunnerEvidenceKind = keyof typeof RUNNER_EVIDENCE_KINDS;

function isRunnerEvidenceKind(v: unknown): v is RunnerEvidenceKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RUNNER_EVIDENCE_KINDS, v);
}

const MAX_LINEAGE_DEPTH = 6;

function refuse(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

const storageRefusal = () => refuse('Evidence storage unavailable', 424);

/** Walks parent_task_id to the chain's root, bounded; the task itself when it has no parent. */
async function findRootTaskId(taskId: string): Promise<string> {
  let current = taskId;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    const t = await db.query.tasks.findFirst({
      where: eq(tasks.id, current),
      columns: { id: true, parentTaskId: true },
    });
    if (!t?.parentTaskId) break;
    current = t.parentTaskId;
  }
  return current;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return refuse('Worker not found', 404);
  }

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A cloud container's per-task token may write evidence for its own worker only.
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) {
    return refuse('Unauthorized', 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return refuse('Invalid JSON body', 400);
  }

  // NOTE: body.key / body.storageKey are deliberately NOT read. The key is ours.
  const { kind, seq, sizeBytes } = body as { kind?: unknown; seq?: unknown; sizeBytes?: unknown };

  if (!isRunnerEvidenceKind(kind)) {
    return refuse(`kind must be one of: ${Object.keys(RUNNER_EVIDENCE_KINDS).join(', ')}`, 400);
  }
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    return refuse('seq must be a non-negative integer', 400);
  }
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return refuse('sizeBytes must be a positive integer', 400);
  }

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, accountId: true, claimedByUserId: true, workspaceId: true, taskId: true },
    with: { workspace: { columns: { teamId: true, dataClass: true } } },
  });
  if (!worker) {
    return refuse('Worker not found', 404);
  }
  if (!callerOwnsWorker(account, worker)) {
    return refuse('Forbidden', 403);
  }
  const workspace = worker.workspace;
  if (!worker.workspaceId || !workspace?.teamId || workspace.teamId !== account.teamId) {
    return refuse('Forbidden', 403);
  }
  if (!worker.taskId) {
    return refuse('Worker has no task to attach evidence to', 409);
  }

  let backend: ResolvedEvidenceBackend;
  try {
    backend = await resolveEvidenceBackend(worker.workspaceId);
  } catch {
    return storageRefusal();
  }

  const byo = backend.provider !== 'buildd_default';
  const sensitive = workspace.dataClass === 'sensitive';
  if (sensitive && !byo) {
    return refuse('Evidence upload is not permitted for sensitive workspaces without a team-owned storage backend', 403);
  }
  if (!backend.usable) {
    return storageRefusal();
  }

  const cap = backend.maxBytesPerTask;
  let usedBytes: number;
  try {
    const [row] = await db
      .select({ total: sql<number | string | null>`coalesce(sum(${evidenceObjects.bytes}), 0)` })
      .from(evidenceObjects)
      .where(and(eq(evidenceObjects.taskId, worker.taskId), ne(evidenceObjects.uploadState, 'failed')));
    usedBytes = Number(row?.total ?? 0);
    if (!Number.isFinite(usedBytes)) return storageRefusal();
  } catch {
    return storageRefusal();
  }
  if (usedBytes + sizeBytes > cap) {
    return refuse('Evidence exceeds the per-task byte limit', 413, {
      maxBytesPerTask: cap,
      usedBytes,
    });
  }

  let rootTaskId: string;
  let key: string;
  try {
    rootTaskId = await findRootTaskId(worker.taskId);
    key = buildEvidenceObjectKey(
      backend.prefix,
      worker.workspaceId,
      rootTaskId,
      worker.taskId,
      worker.id,
      kind,
      `${Date.now()}-${seq}.${RUNNER_EVIDENCE_KINDS[kind]}.gz`,
    );
  } catch {
    return storageRefusal();
  }

  let uploadUrl: string;
  try {
    uploadUrl = await generateEvidenceUploadUrl(backend, key, sizeBytes);
  } catch {
    // The error text may name the bucket or echo provider detail; none of it is returned.
    return storageRefusal();
  }

  const now = new Date();
  let evidenceId: string;
  try {
    const [row] = await db.insert(evidenceObjects).values({
      workspaceId: worker.workspaceId,
      taskId: worker.taskId,
      rootTaskId,
      workerId: worker.id,
      kind,
      backendId: backend.backendId,
      objectKey: key,
      bytes: sizeBytes,
      uploadState: 'pending',
      // Sensitive evidence is never sent to the embedder (invariant 7).
      indexState: sensitive ? 'skipped' : 'queued',
      expiresAt: new Date(now.getTime() + backend.retentionDays * 24 * 60 * 60 * 1000),
    }).returning({ id: evidenceObjects.id });
    if (!row?.id) return storageRefusal();
    evidenceId = row.id;
  } catch {
    return storageRefusal();
  }

  // Whitelisted fields only: nothing from the backend row (bucket, endpoint,
  // credential id) reaches the runner beyond what the signed URL itself carries.
  return NextResponse.json({
    uploadUrl,
    key,
    evidenceId,
    contentLength: sizeBytes,
    expiresIn: EVIDENCE_UPLOAD_EXPIRY_SECONDS,
  });
}
