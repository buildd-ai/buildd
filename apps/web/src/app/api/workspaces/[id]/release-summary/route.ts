import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { approveReleaseSummary, loadReleaseSummary } from '@/lib/release/summary-store';
import { releaseSummaryLines } from '@/lib/release/summary';
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';

/**
 * The review-by-risk release summary (spec 62e985a8 R-6, R-7).
 *
 * GET: the summary for the release source's head now: every PR merged since
 * the last release, built-ahead and risk-area items first, named with the
 * source and target the workspace's release config gives. Readable by anyone
 * who can read the workspace.
 *
 * POST `{ headSha }`: a person approves that summary. A signed-in dashboard
 * session only, like approving a spec revision: an API key, task token or MCP
 * session is refused, so no agent approves a release. The approval covers
 * exactly `headSha`; a source head that moved since is refused.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  if (!isUuid(workspaceId)) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = user ? null : await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const hasAccess = apiAccount
    ? await verifyAccountWorkspaceAccess(apiAccount, workspaceId)
    : await verifyWorkspaceAccess(user!.id, workspaceId);
  if (!hasAccess) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const read = await loadReleaseSummary(workspaceId);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status });
  return NextResponse.json({
    required: read.required,
    approved: read.approved,
    omitted: read.omitted,
    summary: read.summary,
    lines: releaseSummaryLines(read.summary),
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  if (!isUuid(workspaceId)) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  const user = await getCurrentUser();
  const hasBearer = !!req.headers.get('authorization');
  if (!user || hasBearer) {
    return NextResponse.json(
      { error: 'Only a person signed in to buildd can approve a release summary; open the workspace settings page to approve it.' },
      { status: user || hasBearer ? 403 : 401 },
    );
  }
  if (!(await verifyWorkspaceAccess(user.id, workspaceId))) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const body = await req.json().catch(() => null) as { headSha?: unknown } | null;
  const headSha = typeof body?.headSha === 'string' ? body.headSha.trim() : '';
  if (!/^[0-9a-f]{40}$/i.test(headSha)) return NextResponse.json({ error: 'headSha (the full commit the summary describes) is required' }, { status: 400 });

  const approved = await approveReleaseSummary({ workspaceId, userId: user.id, headSha });
  if (!approved.ok) return NextResponse.json({ error: approved.error }, { status: approved.status });
  fireGateEvent({
    gate: GATE_SLUGS.REVIEW_BY_RISK,
    surface: 'POST /api/workspaces/[id]/release-summary',
    outcome: 'bypassed',
    reason: 'a person approved the release summary',
    workspaceId,
    callerOrigin: 'dashboard',
    detail: { kind: 'release_summary', headSha: approved.headSha, approvedBy: user.id },
  });
  return NextResponse.json({ approved: true, headSha: approved.headSha });
}
