/**
 * POST /api/prs/[prNumber]/merge-readiness
 *
 * A review card's "Assess": can this PR merge as-is? Runs the
 * `buildd.merge_readiness` decision (lib/merge-readiness-decision.ts) over the
 * facts Home signed when it built the card, on the team's decision model, and
 * returns the one line the card shows (or none). Advisory only: nothing here
 * merges, reviews or gates.
 *
 * Body: `{ workspaceId, token }`. The token binds the facts to one
 * (workspace, PR, head) and expires; the session must still have access to
 * the workspace, and the PR's live head must still be the signed one, else
 * 409 `head_moved` (the card is stale; reload). Spends at most once per head
 * and facts: a repeat tap returns the stored answer.
 *
 * Auth: session user who has access to the workspace.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveOpenWorkerForUser } from '@/lib/pr-resolve';
import { verifyMergeAdviceToken } from '@/lib/merge-advice-server';
import { askMergeReadiness } from '@/lib/merge-readiness-decision';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ prNumber: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { prNumber: raw } = await params;
  const prNumber = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  const body = await req.json().catch(() => null) as { workspaceId?: unknown; token?: unknown } | null;
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : null;
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const verdict = verifyMergeAdviceToken(body?.token);
  if (!verdict.ok) {
    return NextResponse.json({ error: `Invalid request token (${verdict.reason})`, code: verdict.reason }, { status: 400 });
  }
  const payload = verdict.payload;
  if (payload.prNumber !== prNumber || payload.workspaceId !== workspaceId) {
    return NextResponse.json({ error: 'Token is for another PR', code: 'mismatch' }, { status: 400 });
  }

  const resolved = await resolveOpenWorkerForUser(user.id, prNumber, workspaceId);
  if (typeof resolved.status === 'number') {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const worker = resolved as { workspaceId: string; lastCommitSha: string | null };
  if (worker.workspaceId !== workspaceId) {
    return NextResponse.json({ error: 'PR is not in this workspace' }, { status: 404 });
  }
  if (worker.lastCommitSha !== payload.headSha) {
    return NextResponse.json({ error: 'The PR has new commits; reload to assess the current head', code: 'head_moved' }, { status: 409 });
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  if (!workspace?.teamId) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const result = await askMergeReadiness({ payload, teamId: workspace.teamId, userId: user.id });
  return NextResponse.json(result);
}
