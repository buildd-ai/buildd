/**
 * POST /api/knowledge/ingest-jobs/[id]/complete — finish a claimed ingest job
 * (KM v2 spec §3.3, stream A2).
 *
 * Records status/stats/error on the job row via an atomic
 * UPDATE … WHERE status='running' RETURNING (409 when the job isn't running).
 *
 * `sweep: true` on a successful full run prunes file-derived chunks in the
 * workspace's code/docs namespaces that this run did not refresh (every upsert
 * bumps updated_at, so anything older than the job's startedAt is a file that
 * no longer exists at the ingested sha). Opt-in because it also removes
 * manually ingested file chunks from other source trees sharing the namespace.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { knowledgeChunks, knowledgeIngestJobs } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getIngestAccessibleWorkspaceIds } from '@/lib/knowledge-ingest-access';

interface CompleteBody {
  status?: unknown;
  stats?: unknown;
  error?: unknown;
  changedFiles?: unknown;
  sweep?: unknown;
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

  let body: CompleteBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const status = body.status;
  if (status !== 'done' && status !== 'error') {
    return NextResponse.json({ error: "status must be 'done' or 'error'" }, { status: 400 });
  }

  const job = await db.query.knowledgeIngestJobs.findFirst({
    where: (jobs, { eq: eqOp }) => eqOp(jobs.id, id),
  });
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  const accessible = await getIngestAccessibleWorkspaceIds(account.id);
  if (!accessible.has(job.workspaceId)) {
    return NextResponse.json({ error: 'No access to this workspace' }, { status: 403 });
  }

  const stats =
    body.stats && typeof body.stats === 'object' ? (body.stats as Record<string, unknown>) : undefined;
  const changedFiles = Array.isArray(body.changedFiles)
    ? body.changedFiles.filter((f): f is string => typeof f === 'string')
    : undefined;

  const updated = await db
    .update(knowledgeIngestJobs)
    .set({
      status,
      finishedAt: new Date(),
      ...(stats ? { stats } : {}),
      ...(changedFiles ? { changedFiles } : {}),
      ...(status === 'error' && typeof body.error === 'string' ? { error: body.error } : {}),
    })
    .where(and(eq(knowledgeIngestJobs.id, id), eq(knowledgeIngestJobs.status, 'running')))
    .returning();
  if (updated.length === 0) {
    return NextResponse.json({ error: `Job is ${job.status}, expected running` }, { status: 409 });
  }

  let prunedChunks = 0;
  if (status === 'done' && body.sweep === true && job.scope === 'full' && job.startedAt) {
    try {
      const pruned = await db
        .delete(knowledgeChunks)
        .where(
          and(
            inArray(knowledgeChunks.namespace, [
              `${job.workspaceId}:code`,
              `${job.workspaceId}:docs`,
            ]),
            isNotNull(knowledgeChunks.sourcePath),
            lt(knowledgeChunks.updatedAt, job.startedAt),
          ),
        )
        .returning({ id: knowledgeChunks.id });
      prunedChunks = pruned.length;

      if (prunedChunks > 0) {
        // Best-effort: reflect the prune in the stored stats for the health UI.
        await db
          .update(knowledgeIngestJobs)
          .set({ stats: { ...(stats ?? {}), prunedChunks } })
          .where(eq(knowledgeIngestJobs.id, id))
          .returning();
      }
    } catch (err) {
      console.error(`[knowledge-ingest] sweep failed for job ${id}:`, err);
    }
  }

  return NextResponse.json({ job: updated[0], prunedChunks });
}
