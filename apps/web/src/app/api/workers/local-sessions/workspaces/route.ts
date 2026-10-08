/**
 * The person's workspaces, for the agent plugin: the hooks scope presence
 * against these repos (apps/runner/plugin/scripts/buildd-hook.mjs), and
 * `buildd install` picks the folders it registers buildd for from them
 * (apps/runner/src/agent-plugin-install.ts), across every team the person is
 * in, not just the one their login key belongs to.
 *
 * GET -> { workspaces: [{ id, repo: "owner/name", teamId }] }, one per
 * workspace with a repo. Nothing else: no name, config or members. The id is
 * what the per-workspace OAuth MCP endpoint (/api/mcp-oauth/<id>) is bound to.
 *
 * Auth: the person's presence token only. An account API key or a per-task
 * token reads GET /api/workspaces instead, scoped to what it reaches.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { normalizeRepoSlug } from '@buildd/shared';
import { authenticatePresenceToken, isPresenceToken } from '@/lib/presence-token';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  if (!isPresenceToken(token)) {
    return NextResponse.json({ error: 'A presence token is required (buildd login issues one).' }, { status: 401 });
  }
  const person = await authenticatePresenceToken(token);
  if (!person) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  const reachable = await listReachableWorkspaceIds({ userId: person.userId });
  const rows = reachable.length
    ? await db
      .select({ id: workspaces.id, repo: workspaces.repo, teamId: workspaces.teamId })
      .from(workspaces)
      .where(inArray(workspaces.id, reachable))
    : [];
  const list = rows
    .map(r => ({ id: r.id, repo: normalizeRepoSlug(r.repo)?.toLowerCase() ?? null, teamId: r.teamId }))
    .filter((w): w is { id: string; repo: string; teamId: string } => !!w.repo)
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.id.localeCompare(b.id));
  return NextResponse.json({ workspaces: list });
}
