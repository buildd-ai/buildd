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
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { authenticateApiKey } from '@/lib/api-auth';
import { getIngestAccessibleWorkspaceIds } from '@/lib/knowledge-ingest-access';
import {
  shouldIngestFile,
  classifyIngestCorpus,
} from '@buildd/core/knowledge-store/ingest-filter';

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

  const authHeader = req.headers.get('authorization');
  const account = await authenticateApiKey(authHeader?.replace('Bearer ', '') || null);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
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
  const accessible = await getIngestAccessibleWorkspaceIds(account.id);
  if (!accessible.has(job.workspaceId)) {
    return NextResponse.json({ error: 'No access to this workspace' }, { status: 403 });
  }
  if (job.status !== 'running') {
    return NextResponse.json({ error: `Job is ${job.status}, expected running` }, { status: 409 });
  }

  try {
    // Dynamic import keeps this module light for route tests (the store pulls
    // in drizzle/pgvector machinery at load time) — same as knowledge-ingest.ts.
    const { PgVectorStore, getVoyageEmbedder, buildNamespace, ingestFiles } =
      await import('@buildd/core/knowledge-store');
    const store = new PgVectorStore(getVoyageEmbedder('voyage-code-3'));

    let filesDeleted = 0;
    for (const path of deletions) {
      const corpus = classifyIngestCorpus(path);
      if (!corpus) continue;
      await store.deleteBySource(buildNamespace(job.workspaceId, corpus), { sourcePath: path });
      filesDeleted++;
    }

    // Build per-corpus file lists, checking file_hash to skip unchanged files.
    const sources: Record<'code' | 'docs', Array<{ path: string; content: string; fileHash?: string }>> = {
      code: [],
      docs: [],
    };
    let filesSkipped = 0;
    let skippedUnchanged = 0;
    for (const file of files) {
      const sizeBytes = Buffer.byteLength(file.content, 'utf8');
      if (!shouldIngestFile(file.path, { sizeBytes })) {
        filesSkipped++;
        continue;
      }
      const corpus = classifyIngestCorpus(file.path);
      if (!corpus) {
        filesSkipped++;
        continue;
      }
      // Hash-skip: if the caller supplied a fileHash and a chunk already exists
      // for this path with the same file_hash, the file is unchanged — skip it.
      if (file.fileHash) {
        const ns = buildNamespace(job.workspaceId, corpus);
        const existing = await db.execute(
          sql`SELECT 1 FROM knowledge_chunks
              WHERE namespace = ${ns}
                AND source_path = ${file.path}
                AND file_hash = ${file.fileHash}
                AND is_current = true
              LIMIT 1`,
        );
        if (existing.rows.length > 0) {
          skippedUnchanged++;
          // Bump updated_at so the sweep at job completion doesn't prune these chunks.
          await db.execute(
            sql`UPDATE knowledge_chunks
                SET updated_at = NOW()
                WHERE namespace = ${ns}
                  AND source_path = ${file.path}
                  AND file_hash = ${file.fileHash}`,
          );
          continue;
        }
      }
      sources[corpus].push(file);
    }

    let filesIngested = 0;
    let chunksUpserted = 0;
    for (const corpus of ['code', 'docs'] as const) {
      if (sources[corpus].length === 0) continue;
      const sourceFiles = sources[corpus].map(f => ({ ...f }));
      const res = await ingestFiles(store, job.workspaceId, corpus, sourceFiles);
      filesIngested += res.files;
      chunksUpserted += res.chunks;
    }

    return NextResponse.json({ filesIngested, chunksUpserted, filesSkipped, filesDeleted, skippedUnchanged });
  } catch (err) {
    console.error(`[knowledge-ingest] files batch failed for job ${id}:`, err);
    return NextResponse.json({ error: 'Batch ingest failed' }, { status: 500 });
  }
}
