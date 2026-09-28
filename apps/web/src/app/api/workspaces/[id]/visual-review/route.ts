/**
 * GET /api/workspaces/[id]/visual-review: the workspace's missions with
 * screens awaiting a human decision, each with its count
 * (`loadWorkspaceAwaitingReview`). The MCP `get_visual_review` action reads
 * this when it is given a workspace and no mission.
 *
 * Auth and access are the mission read's (GET /api/missions/[id]/visual-review):
 * a session, or an admin-level key; the workspace's team must be one of the
 * caller's, and the caller must reach the workspace. Anything else is a 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds, verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { loadWorkspaceAwaitingReview } from '@/lib/visual-review-load';
import { isUuid } from '@/lib/uuid';

const notFound = () => NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = user ? null : await authenticateApiKey(apiKey);
  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }
  if (!isUuid(id)) return notFound();

  const teamIds = await resolveAccountTeamIds(user, apiAccount);
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { id: true, name: true, teamId: true },
  });
  if (!ws || !teamIds.includes(ws.teamId)) return notFound();
  const reaches = user
    ? (await verifyWorkspaceAccess(user.id, ws.id)) !== null
    : await verifyAccountWorkspaceAccess(apiAccount!.id, ws.id);
  if (!reaches) return notFound();

  const { missions, more } = await loadWorkspaceAwaitingReview(ws.id, teamIds);
  return NextResponse.json(
    { workspace: { id: ws.id, name: ws.name }, missions, more },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
