/**
 * POST /api/workers/[id]/replacement
 *
 * A person's "Link replacement": name the PR that replaces this worker's
 * closed-unmerged PR. Body `{ prNumber }`. Answers `{ ok, prNumber, url }`.
 *
 * Display only (lib/pr-named-replacement.ts): it is not verified and no
 * completion or merge gate reads it. The formal supersession still records
 * when the replacement merges.
 *
 * Person-only, like marking a PR abandoned (tasks/[id]/closed-pr): a dashboard
 * session, or the person's own OAuth session. An API key or task token is
 * refused. 400 a prNumber that is not a positive integer or is the PR itself;
 * 404 a worker outside the caller's workspaces or with no PR; 409 a merged PR.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { requestingPerson } from '@/lib/request-person';
import { isUuid } from '@/lib/uuid';
import { resolvePrRepo } from '@/lib/repo-scope';
import { linkNamedReplacement } from '@/lib/pr-named-replacement-store';
import type { LinkWorkerReplacementResponse } from '@buildd/shared';

export const dynamic = 'force-dynamic';

const notFound = (error = 'Worker not found') => NextResponse.json({ error }, { status: 404 });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // A non-simple request, so another origin cannot fire it from a plain form.
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }
  if (!requestingPerson(user, apiAccount)) {
    return NextResponse.json({
      error: 'Only a person can link a replacement PR: use the dashboard or an interactive (OAuth) session.',
    }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as { prNumber?: unknown } | null;
  const prNumber = body?.prNumber;
  if (typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return NextResponse.json({ error: 'prNumber must be a positive integer' }, { status: 400 });
  }

  try {
    const worker = await db.query.workers.findFirst({
      where: sqlWhere(eq(workers.id, id)),
      columns: { id: true, workspaceId: true, prNumber: true, prUrl: true, mergedAt: true },
      with: { workspace: { columns: { repo: true } } },
    });
    const hasAccess = worker && (apiAccount
      ? await verifyAccountWorkspaceAccess(apiAccount, worker.workspaceId)
      : await verifyWorkspaceAccess(user!.id, worker.workspaceId));
    if (!worker || !hasAccess) return notFound();
    if (!worker.prNumber) return notFound('Worker has no PR');

    const repoFullName = resolvePrRepo({ prUrl: worker.prUrl, workspaceRepo: worker.workspace?.repo });
    if (!repoFullName) return notFound('Worker has no PR');
    if (prNumber === worker.prNumber) {
      return NextResponse.json({ error: 'A PR cannot be its own replacement' }, { status: 400 });
    }
    if (worker.mergedAt) {
      return NextResponse.json({ error: `PR #${worker.prNumber} merged; a merged PR has no replacement` }, { status: 409 });
    }

    const { updated, url } = await linkNamedReplacement({ workerId: worker.id, repoFullName, prNumber });
    if (!updated) {
      return NextResponse.json({ error: `PR #${worker.prNumber} merged; a merged PR has no replacement` }, { status: 409 });
    }
    return NextResponse.json({ ok: true, prNumber, url } satisfies LinkWorkerReplacementResponse);
  } catch (error) {
    console.error('Link replacement PR error:', error);
    return NextResponse.json({ error: 'Failed to link the replacement' }, { status: 500 });
  }
}
