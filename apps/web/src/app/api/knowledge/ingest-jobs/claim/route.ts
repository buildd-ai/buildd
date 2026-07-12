/**
 * POST /api/knowledge/ingest-jobs/claim — runner/CI claim of a `full`-scope
 * knowledge ingest job (KM v2 spec §3.3, stream A2).
 *
 * The caller offers the "owner/name" repos it holds checkouts for; the route
 * returns the oldest queued full job for one of them in a workspace the
 * account can claim in. Claim is an atomic UPDATE … WHERE status='queued'
 * RETURNING — concurrent callers race safely, losers fall through to the next
 * candidate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { knowledgeIngestJobs } from '@buildd/core/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getIngestAccessibleWorkspaceIds } from '@/lib/knowledge-ingest-access';

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

  let body: { repos?: unknown };
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

  const accessible = await getIngestAccessibleWorkspaceIds(account.id);

  const candidates = await db
    .select()
    .from(knowledgeIngestJobs)
    .where(and(eq(knowledgeIngestJobs.status, 'queued'), eq(knowledgeIngestJobs.scope, 'full')))
    .orderBy(asc(knowledgeIngestJobs.createdAt))
    .limit(MAX_CANDIDATES);

  for (const candidate of candidates) {
    if (!repoSet.has(candidate.repo.toLowerCase())) continue;
    if (!accessible.has(candidate.workspaceId)) continue;

    const claimed = await db
      .update(knowledgeIngestJobs)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(knowledgeIngestJobs.id, candidate.id), eq(knowledgeIngestJobs.status, 'queued')))
      .returning();
    if (claimed.length > 0) {
      return NextResponse.json({ job: claimed[0] });
    }
    // Lost the race for this job — try the next candidate.
  }

  return NextResponse.json({ job: null });
}
