/**
 * The server half of a `full`-scope ingest, shared by the two executors that
 * feed it: the runner (which streams batches to
 * /api/knowledge/ingest-jobs/[id]/files) and the serverless fallback (which
 * reads the repo through the GitHub API when no runner can). Keeping one copy
 * means both apply the same filter, the same hash-skip and the same sweep.
 */
import { and, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { knowledgeChunks } from '@buildd/core/db/schema';
import {
  shouldIngestFile,
  classifyIngestCorpus,
} from '@buildd/core/knowledge-store/ingest-filter';
import { admitDocsWithinCap } from '@buildd/core/billing-limits';

export interface IngestBatchFile {
  path: string;
  content: string;
  /** SHA-256 of the full file content; lets an unchanged file be skipped. */
  fileHash?: string;
}

export interface IngestBatchResult {
  filesIngested: number;
  chunksUpserted: number;
  filesSkipped: number;
  filesDeleted: number;
  skippedUnchanged: number;
  /** New docs the plan's knowledge-base cap turned away (0 while BILLING_ENFORCED is off). */
  filesRefusedByPlan: number;
  /** The plain refusal to show the owner, when anything was refused. */
  planLimitMessage?: string;
}

/**
 * Filter, hash-skip, chunk, embed and upsert one batch of files into the
 * workspace's code/docs namespaces, and delete chunks for `deletions`.
 * Throws on a store/embedding failure; callers decide how to report it.
 */
export async function ingestFileBatch(
  workspaceId: string,
  files: IngestBatchFile[],
  deletions: string[] = [],
): Promise<IngestBatchResult> {
  // Dynamic import keeps importers light for route tests (the store pulls in
  // drizzle/pgvector machinery at load time) — same as knowledge-ingest.ts.
  const { PgVectorStore, getVoyageEmbedder, buildNamespace, ingestFiles } =
    await import('@buildd/core/knowledge-store');
  const store = new PgVectorStore(getVoyageEmbedder('voyage-code-3'));

  let filesDeleted = 0;
  for (const path of deletions) {
    const corpus = classifyIngestCorpus(path);
    if (!corpus) continue;
    await store.deleteBySource(buildNamespace(workspaceId, corpus), { sourcePath: path });
    filesDeleted++;
  }

  // Build per-corpus file lists, checking file_hash to skip unchanged files.
  const sources: Record<'code' | 'docs', IngestBatchFile[]> = { code: [], docs: [] };
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
      const ns = buildNamespace(workspaceId, corpus);
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

  // Plan knowledge-base cap: new docs past it are refused; updates to docs
  // already stored always go through, and nothing stored is touched.
  const admission = await admitDocsWithinCap(workspaceId, sources.docs.map(f => f.path));
  if (admission.refused.length > 0) {
    const refused = new Set(admission.refused);
    sources.docs = sources.docs.filter(f => !refused.has(f.path));
  }

  let filesIngested = 0;
  let chunksUpserted = 0;
  for (const corpus of ['code', 'docs'] as const) {
    if (sources[corpus].length === 0) continue;
    const sourceFiles = sources[corpus].map(f => ({ ...f }));
    const res = await ingestFiles(store, workspaceId, corpus, sourceFiles);
    filesIngested += res.files;
    chunksUpserted += res.chunks;
  }

  return {
    filesIngested, chunksUpserted, filesSkipped, filesDeleted, skippedUnchanged,
    filesRefusedByPlan: admission.refused.length,
    ...(admission.message ? { planLimitMessage: admission.message } : {}),
  };
}

/**
 * After a successful full run: prune file-derived chunks in the workspace's
 * code/docs namespaces that the run did not refresh. Every upsert (and every
 * hash-skip) bumps updated_at, so anything older than `runStartedAt` belongs to
 * a file that no longer exists at the ingested sha. Returns the count deleted.
 */
export async function sweepUnrefreshedFileChunks(workspaceId: string, runStartedAt: Date): Promise<number> {
  const pruned = await db
    .delete(knowledgeChunks)
    .where(
      and(
        inArray(knowledgeChunks.namespace, [`${workspaceId}:code`, `${workspaceId}:docs`]),
        isNotNull(knowledgeChunks.sourcePath),
        lt(knowledgeChunks.updatedAt, runStartedAt),
      ),
    )
    .returning({ id: knowledgeChunks.id });
  return pruned.length;
}
