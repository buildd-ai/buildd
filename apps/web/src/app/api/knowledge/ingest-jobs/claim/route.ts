/**
 * POST /api/knowledge/ingest-jobs/claim — runner/CI claim of a `full`-scope
 * knowledge ingest job (KM v2 spec §3.3, stream A2).
 *
 * The caller offers the "owner/name" repos it holds checkouts for; the route
 * returns the oldest queued full job for one of them in a workspace the
 * account can claim in. Claim is an atomic UPDATE … WHERE status='queued'
 * RETURNING — concurrent callers race safely, losers fall through to the next
 * candidate.
 *
 * Every claim stamps a lease (lease_owner + lease_expires_at + heartbeat_at) and
 * every poll first reclaims jobs whose lease lapsed. Before that, a runner that
 * died mid-job left the row in `running` forever, and because the partial unique
 * index `knowledge_ingest_jobs_active_full_idx` counts `running` as active, the
 * workspace's full-ingest slot was wedged permanently. The runner poll is the
 * reclaim trigger deliberately: a dedicated cron is one more thing that can
 * silently never fire.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { knowledgeIngestJobs } from '@buildd/core/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getIngestAccessibleWorkspaceIds } from '@/lib/knowledge-ingest-access';
import { reclaimStaleIngestJobs, FULL_LEASE_MS } from '@/lib/knowledge-ingest-lease';

const MAX_OFFERED_REPOS = 200;
const MAX_CANDIDATES = 50;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const account = await authenticateApiKey(authHeader?.replace('Bearer ', '') || null);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }
  if (account.level === 'trigger') {
    return NextResponse.json({ error: 'Trigger tokens cannot claim ingest jobs' }, { status: 403 });
  }

  let body: { repos?: unknown; runnerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const repos = body.repos;
  if (!Array.isArray(repos) || repos.length === 0 || !repos.every(r => typeof r === 'string')) {
    return NextResponse.json({ error: 'repos (non-empty string array) is required' }, { status: 400 });
  }
  const repoSet = new Set(repos.slice(0, MAX_OFFERED_REPOS).map(r => r.toLowerCase()));

  // Lease owner: the runner's self-reported id when supplied, else the claiming
  // account. Used only for diagnostics — the lease TTL is what enforces liveness.
  const leaseOwner = typeof body.runnerId === 'string' && body.runnerId ? body.runnerId.slice(0, 200) : account.id;

  const accessible = await getIngestAccessibleWorkspaceIds(account.id);

  // Heal wedged rows first, so anything requeued is visible to the scan below
  // in THIS poll rather than the next one. Never throws.
  const reclaim = await reclaimStaleIngestJobs();

  const candidates = await db
    .select()
    .from(knowledgeIngestJobs)
    .where(and(eq(knowledgeIngestJobs.status, 'queued'), eq(knowledgeIngestJobs.scope, 'full')))
    .orderBy(asc(knowledgeIngestJobs.createdAt))
    .limit(MAX_CANDIDATES);

  for (const candidate of candidates) {
    if (!repoSet.has(candidate.repo.toLowerCase())) continue;
    if (!accessible.has(candidate.workspaceId)) continue;

    const now = new Date();
    const claimed = await db
      .update(knowledgeIngestJobs)
      .set({
        status: 'running',
        startedAt: now,
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + FULL_LEASE_MS),
        heartbeatAt: now,
      })
      .where(and(eq(knowledgeIngestJobs.id, candidate.id), eq(knowledgeIngestJobs.status, 'queued')))
      .returning();
    if (claimed.length > 0) {
      return NextResponse.json({ job: claimed[0], ...reclaimReport(reclaim) });
    }
    // Lost the race for this job — try the next candidate.
  }

  return NextResponse.json({ job: null, ...reclaimReport(reclaim) });
}

/**
 * Surface what the reclaim pass did. `stalled` names queued full jobs no runner
 * is offering a checkout for — without it the queue looks empty rather than
 * blocked, which is exactly how the C12 wedge stayed invisible.
 */
function reclaimReport(reclaim: Awaited<ReturnType<typeof reclaimStaleIngestJobs>>) {
  return {
    ...(reclaim.requeued.length > 0 ? { reclaimed: reclaim.requeued } : {}),
    ...(reclaim.parked.length > 0 ? { parked: reclaim.parked } : {}),
    ...(reclaim.escalated.length > 0 ? { escalated: reclaim.escalated } : {}),
    ...(reclaim.stalled.length > 0 ? { stalled: reclaim.stalled } : {}),
  };
}
