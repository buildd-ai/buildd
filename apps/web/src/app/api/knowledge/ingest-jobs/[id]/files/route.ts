/**
 * POST /api/knowledge/ingest-jobs/[id]/files — batch upload for a claimed
 * `full`-scope ingest job (KM v2 spec §3.3, stream A2).
 *
 * The runner/CI client walks its checkout and streams file batches here; this
 * route applies the shared ingest filter (defense in depth — clients filter
 * too), chunks + embeds via the shared ingest path, and upserts into the
 * workspace's code/docs namespaces. `deletions` removes chunks for paths the
 * client knows are gone (renames); the full-sync prune of everything else
 * happens at /complete.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { knowledgeIngestJobs } from '@buildd/core/db/schema';
import { authenticateApiKey } from '@/lib/api-auth';
import { getIngestAccessibleWorkspaceIds } from '@/lib/knowledge-ingest-access';
import { FULL_LEASE_MS } from '@/lib/knowledge-ingest-lease';
import { isUuid } from '@/lib/uuid';
import { ingestFileBatch } from '@/lib/knowledge-ingest-batch';

// Stay under serverless request-body limits (~4.5 MB) with JSON overhead room.
export const MAX_BATCH_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_BATCH_FILE_COUNT = 64;

interface FilesBody {
  files?: Array<{ path?: unknown; content?: unknown; fileHash?: unknown }>;
  deletions?: unknown;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid ingest job id: expected a UUID, got "${id}".` }, { status: 404 });
  }

  const authHeader = req.headers.get('authorization');
  const account = await authenticateApiKey(authHeader?.replace('Bearer ', '') || null, req);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }
  if (account.level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens cannot upload ingest files' }, { status: 403 });
  }

  let body: FilesBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body.files)) {
    return NextResponse.json({ error: 'files (array) is required' }, { status: 400 });
  }
  if (body.files.length > MAX_BATCH_FILE_COUNT) {
    return NextResponse.json({ error: `files exceeds ${MAX_BATCH_FILE_COUNT} per batch` }, { status: 413 });
  }
  const files: Array<{ path: string; content: string; fileHash?: string }> = [];
  let totalBytes = 0;
  for (const f of body.files) {
    if (typeof f?.path !== 'string' || typeof f?.content !== 'string') {
      return NextResponse.json({ error: 'each file needs string path and content' }, { status: 400 });
    }
    totalBytes += Buffer.byteLength(f.content, 'utf8');
    files.push({
      path: f.path,
      content: f.content,
      ...(typeof f.fileHash === 'string' ? { fileHash: f.fileHash } : {}),
    });
  }
  if (totalBytes > MAX_BATCH_TOTAL_BYTES) {
    return NextResponse.json({ error: `batch exceeds ${MAX_BATCH_TOTAL_BYTES} bytes` }, { status: 413 });
  }
  const deletions = Array.isArray(body.deletions)
    ? body.deletions.filter((d): d is string => typeof d === 'string')
    : [];

  const job = await db.query.knowledgeIngestJobs.findFirst({
    where: (jobs, { eq }) => eq(jobs.id, id),
  });
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  const accessible = await getIngestAccessibleWorkspaceIds(account);
  if (!accessible.has(job.workspaceId)) {
    return NextResponse.json({ error: 'No access to this workspace' }, { status: 403 });
  }
  if (job.status !== 'running') {
    return NextResponse.json({ error: `Job is ${job.status}, expected running` }, { status: 409 });
  }

  // Heartbeat: an accepted batch is proof of forward progress, so push the lease
  // out. A long full ingest would otherwise outrun its TTL and be reclaimed
  // mid-flight (harmless but wasteful — ingest upserts are idempotent).
  const beat = new Date();
  await db
    .update(knowledgeIngestJobs)
    .set({ heartbeatAt: beat, leaseExpiresAt: new Date(beat.getTime() + FULL_LEASE_MS) })
    .where(and(eq(knowledgeIngestJobs.id, id), eq(knowledgeIngestJobs.status, 'running')))
    .returning({ id: knowledgeIngestJobs.id })
    .catch(err => {
      console.error(`[knowledge-ingest] lease renewal failed for job ${id}:`, err);
      return [];
    });

  try {
    const result = await ingestFileBatch(job.workspaceId, files, deletions);
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[knowledge-ingest] files batch failed for job ${id}:`, err);
    return NextResponse.json({ error: 'Batch ingest failed' }, { status: 500 });
  }
}
