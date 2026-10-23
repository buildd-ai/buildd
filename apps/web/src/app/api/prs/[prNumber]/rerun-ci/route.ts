/**
 * POST /api/prs/[prNumber]/rerun-ci
 *
 * Home's Re-run on a PR whose checks failed and look like a flake
 * (docs/specs/surface-ia-home-missions-initiatives.md §11, R-4). Re-runs the
 * failed jobs of the head's latest failed workflow run, and only those,
 * through the GitHub App, then records who re-ran which run on the PR's
 * red-check record. That record is what lets a repeat failure with the same
 * signature promote Start fix ("failed twice").
 *
 * No agent and no fix attempt: nothing is pushed, so the workflow kernel's
 * delivery state moves only through the CI it observes next.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, githubRepos } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { githubApi } from '@/lib/github';
import { recordRedRerun } from '@/lib/red-check-record';
import { sqlWhere } from '@buildd/core/db/relational-sql';

function bad(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ prNumber: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return bad('Unauthorized', 401);

  const { prNumber: prNumberStr } = await params;
  const prNumber = parseInt(prNumberStr, 10);
  if (!prNumber || isNaN(prNumber)) return bad('Invalid PR number', 400);

  const body = await req.json().catch(() => ({}));
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : null;
  if (!workspaceId) return bad('workspaceId is required', 400);

  const accessible = await getUserWorkspaceIds(user.id);
  if (!accessible.includes(workspaceId)) return bad('Workspace not found or not accessible', 403);

  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, workspaceId)) });
  if (!workspace) return bad('Workspace not found', 404);
  if (!workspace.githubRepoId || !workspace.githubInstallationId) return bad('Workspace is not linked to a GitHub repo', 400);
  const repo = await db.query.githubRepos.findFirst({
    where: sqlWhere(eq(githubRepos.id, workspace.githubRepoId)),
    with: { installation: true },
  });
  if (!repo?.installation) return bad('Workspace is not linked to a GitHub repo', 400);
  const installationId = repo.installation.installationId as number;
  const repoFullName = repo.fullName as string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pr: any;
  try {
    pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return bad(`Could not read PR #${prNumber}: ${message}`, message.includes('404') ? 404 : 502);
  }
  if (!pr?.number) return bad(`PR #${prNumber} not found`, 404);
  if (pr.state !== 'open') return bad(`PR #${prNumber} is ${pr.merged ? 'merged' : pr.state}. Only an open PR's checks can be re-run.`, 409);
  const headSha = typeof pr.head?.sha === 'string' ? pr.head.sha : null;
  if (!headSha) return bad(`PR #${prNumber} has no head commit`, 409);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let run: any;
  try {
    const runs = await githubApi(installationId, `/repos/${repoFullName}/actions/runs?head_sha=${headSha}&status=failure`);
    run = runs?.workflow_runs?.[0];
  } catch (error) {
    return bad(`Could not read the checks of PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
  if (typeof run?.id !== 'number') return bad(`PR #${prNumber} has no failed run on its current head to re-run.`, 409);

  try {
    // Failed jobs only: the jobs that passed keep their result.
    await githubApi(installationId, `/repos/${repoFullName}/actions/runs/${run.id}/rerun-failed-jobs`, { method: 'POST' });
  } catch (error) {
    return bad(`GitHub did not re-run the failed jobs: ${error instanceof Error ? error.message : String(error)}`, 502);
  }

  // The record of who re-ran what. GitHub has already accepted the re-run, so a
  // failed write is reported, not undone.
  const recorded = await recordRedRerun({ repoFullName, prNumber, headSha, runId: run.id, by: user.id })
    .then(() => true)
    .catch((err: unknown) => {
      console.warn(`[rerun-ci] re-ran run ${run.id} on ${repoFullName}#${prNumber} but could not record it:`, err);
      return false;
    });
  console.log(`[rerun-ci] user ${user.id} re-ran failed jobs of run ${run.id} on ${repoFullName}#${prNumber}@${headSha}`);

  return NextResponse.json({ ok: true, runId: run.id, headSha, recorded });
}
