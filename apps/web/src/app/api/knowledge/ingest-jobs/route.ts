/**
 * POST /api/knowledge/ingest-jobs  — enqueue a full-scope ingest job for a workspace.
 * GET  /api/knowledge/ingest-jobs  — list recent ingest jobs (admin, optional ?workspaceId=).
 *
 * Replaces the GitHub Actions knowledge-ingest.yml workflow. The runner fleet polls
 * for queued full jobs on idle heartbeat ticks and executes them locally when
 * DATABASE_URL + VOYAGE_API_KEY are provisioned on the runner host. When those env
 * vars are absent the runner falls back to the HTTP batch path (claim → /files →
 * /complete), which is fine for small repos but incurs Vercel billing for large ones.
 *
 * Auth: admin or worker-level API key. Trigger tokens are rejected.
 *
 * Response shapes: 201 + job (enqueued), 200 + reason=already_queued (a job is
 * genuinely in flight), 409 + reason=stalled (a job holds the per-workspace slot
 * and nothing is moving it), 422 + reason=no_github_repo.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, githubRepos, knowledgeIngestJobs } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { enqueueFullIngestJobDetailed } from '@/lib/knowledge-ingest';
import { getIngestAccessibleWorkspaceIds } from '@/lib/knowledge-ingest-access';

type TriggerValue = 'manual' | 'backfill' | 'repo_link' | 'scheduled';

const VALID_TRIGGERS: TriggerValue[] = ['manual', 'backfill', 'repo_link', 'scheduled'];

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const account = await authenticateApiKey(authHeader?.replace('Bearer ', '') || null);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }
  if (account.level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens cannot enqueue ingest jobs' }, { status: 403 });
  }

  let body: { workspaceId?: unknown; trigger?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const workspaceId = body.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    return NextResponse.json({ error: 'workspaceId (string) is required' }, { status: 400 });
  }

  // Worker tokens are scoped to their accessible workspaces; admin tokens can reach any workspace.
  if (account.level !== 'admin') {
    const accessible = await getIngestAccessibleWorkspaceIds(account.id);
    if (!accessible.has(workspaceId)) {
      return NextResponse.json({ error: 'Workspace not found or not accessible' }, { status: 404 });
    }
  }

  const trigger: TriggerValue =
    typeof body.trigger === 'string' && VALID_TRIGGERS.includes(body.trigger as TriggerValue)
      ? (body.trigger as TriggerValue)
      : 'manual';

  // Resolve the workspace's linked GitHub repo ("owner/name").
  const rows = await db
    .select({ repoFullName: githubRepos.fullName })
    .from(workspaces)
    .innerJoin(githubRepos, eq(workspaces.githubRepoId, githubRepos.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json(
      { job: null, reason: 'no_github_repo' },
      { status: 422 },
    );
  }

  const repoFullName = rows[0].repoFullName;
  const outcome = await enqueueFullIngestJobDetailed({
    workspaceId,
    repo: repoFullName,
    trigger,
  });

  // A blocking job that is actually progressing is an idempotent no-op (200).
  // A blocking job that nothing is moving is NOT success: it used to answer 200
  // + already_queued forever, so a caller could never tell "in flight" from
  // "wedged since last Tuesday". 409 + reason=stalled makes the wedge visible.
  if (outcome.status === 'already_queued') {
    return NextResponse.json({ job: null, reason: 'already_queued', activeJob: outcome.job });
  }
  if (outcome.status === 'stalled') {
    return NextResponse.json(
      { job: null, reason: 'stalled', activeJob: outcome.job },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      job: {
        id: outcome.jobId,
        workspaceId,
        repo: repoFullName,
        trigger,
        scope: 'full',
        status: 'queued',
      },
    },
    { status: 201 },
  );
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const account = await authenticateApiKey(authHeader?.replace('Bearer ', '') || null);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }
  if (account.level !== 'admin') {
    return NextResponse.json({ error: 'Admin-level API key required' }, { status: 403 });
  }

  const workspaceId = new URL(req.url).searchParams.get('workspaceId');

  const query = workspaceId
    ? db
        .select()
        .from(knowledgeIngestJobs)
        .where(eq(knowledgeIngestJobs.workspaceId, workspaceId))
        .orderBy(desc(knowledgeIngestJobs.createdAt))
        .limit(20)
    : db
        .select()
        .from(knowledgeIngestJobs)
        .orderBy(desc(knowledgeIngestJobs.createdAt))
        .limit(20);

  const jobs = await query;
  return NextResponse.json({ jobs });
}
