import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { and, inArray } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { workspaceRepoMatches } from '@/lib/repo-scope';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';
import { toPublicWorkspace } from '@/lib/workspace-public';

/**
 * Look up the workspace for a repo, among the workspaces the caller can reach
 * (lib/workspace-access.ts): an API account reaches its own team's open
 * workspaces plus its explicit links; a session user reaches their teams'
 * workspaces. The same rule as GET /api/workspaces.
 *
 * A workspace outside that set answers 404 exactly like a repo with no
 * workspace at all, so this route cannot be used to learn whether another
 * team has a workspace for a repo.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey, req);
  const user = account ? null : await getCurrentUser();

  if (!account && !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const repoFullName = req.nextUrl.searchParams.get('repo');
  if (!repoFullName) {
    return NextResponse.json({ error: 'repo parameter required' }, { status: 400 });
  }

  const notFound = NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const reachableIds = await listReachableWorkspaceIds(
    account ? { account } : { userId: user!.id },
  );
  if (reachableIds.length === 0) return notFound;

  // Matches on a normalized owner/name, since `workspaces.repo` may hold a bare
  // full name or a clone URL. Searching only the reachable set (rather than
  // finding globally and then checking) also means another team's workspace
  // for the same repo can never shadow the caller's own.
  const workspace = await db.query.workspaces.findFirst({
    where: and(workspaceRepoMatches(repoFullName), inArray(workspaces.id, reachableIds)),
  });
  // The rule is re-checked on the row itself, so a query-level slip can never
  // hand back a workspace the caller could not have listed.
  if (!workspace || !reachableIds.includes(workspace.id)) return notFound;

  // Allowlisted fields only — the row carries webhook_config.token.
  return NextResponse.json({ workspace: toPublicWorkspace(workspace) });
}
