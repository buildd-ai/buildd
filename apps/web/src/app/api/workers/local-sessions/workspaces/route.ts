/**
 * The workspace repos the agent plugin's hooks scope presence against
 * (apps/runner/plugin/scripts/buildd-hook.mjs): a hook reports a session only
 * when it opens in one of these repos.
 *
 * GET -> { workspaces: [{ repo: "owner/name" }] }. Only the repo slug, never a
 * workspace id, name or config: that is all the hook needs.
 *
 * Auth: the person's presence token (every workspace they reach, across all
 * their teams), or an account API key (what that key reaches, as
 * GET /api/workspaces lists it).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { normalizeRepoSlug } from '@buildd/shared';
import { authenticateApiKey } from '@/lib/api-auth';
import { authenticatePresenceToken, isPresenceToken } from '@/lib/presence-token';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  let reachable: string[];
  if (isPresenceToken(token)) {
    const person = await authenticatePresenceToken(token);
    if (!person) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    reachable = await listReachableWorkspaceIds({ userId: person.userId });
  } else {
    const account = await authenticateApiKey(token, req);
    if (!account) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    reachable = (await listReachableWorkspaceIds({ account }))
      .filter(id => account.workspaceIds == null || account.workspaceIds.includes(id));
  }
  const rows = reachable.length
    ? await db.select({ repo: workspaces.repo }).from(workspaces).where(inArray(workspaces.id, reachable))
    : [];
  const repos = [...new Set(rows.map(r => normalizeRepoSlug(r.repo)).filter((r): r is string => !!r).map(r => r.toLowerCase()))].sort();
  return NextResponse.json({ workspaces: repos.map(repo => ({ repo })) });
}
