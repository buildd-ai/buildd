/**
 * GET /api/workspaces/[id]/readiness
 *
 * The onboarding checklist (docs/design/workspace-onboarding.md §2): what a
 * workspace's repo has and lacks for buildd workers to do reliable work in it,
 * and the first unmet step (`nextStep`).
 *
 * Read-only and idempotent: recomputed from the repo on every call, never
 * stored, nothing written. A workspace with no linked repo answers
 * `nextStep: 'link-repo'` without calling GitHub.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { computeWorkspaceReadiness } from '@/lib/workspace-readiness-io';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  const user = await getCurrentUser();

  if (!apiAccount && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // An API key reads its own team's workspaces only; `accessMode: 'open'` does
  // not widen this (same rule as policy-init). A 404, not a 403, so a workspace
  // id in another team is indistinguishable from one that does not exist.
  if (apiAccount) {
    const owner = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, id),
      columns: { teamId: true },
    });
    if (!owner || owner.teamId !== apiAccount.teamId) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  } else if (user) {
    const access = await verifyWorkspaceAccess(user.id, id);
    if (!access) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { id: true, gitConfig: true, configStatus: true, releaseConfig: true },
    with: { githubRepo: { with: { installation: true } } },
  });
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    const report = await computeWorkspaceReadiness({
      id: workspace.id,
      gitConfig: workspace.gitConfig,
      configStatus: workspace.configStatus,
      releaseConfig: workspace.releaseConfig,
      githubRepo: workspace.githubRepo
        ? {
            fullName: workspace.githubRepo.fullName,
            installation: workspace.githubRepo.installation
              ? { installationId: workspace.githubRepo.installation.installationId }
              : null,
          }
        : null,
    });
    return NextResponse.json(report);
  } catch (err) {
    console.warn(`[readiness] Could not read repo for workspace ${id}:`, err);
    return NextResponse.json(
      { error: `Could not read the repository: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 502 },
    );
  }
}
