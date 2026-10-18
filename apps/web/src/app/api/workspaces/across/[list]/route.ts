/**
 * GET /api/workspaces/across/{artifacts|schedules|skills}: one list over
 * every workspace the caller reaches, in one query (spec 3ef37387 R-22).
 *
 * The MCP `list_artifacts`, `list_schedules` and `list_skills` actions with
 * no workspace used to read `/api/workspaces` and then call the per-workspace
 * route once per workspace. This answers the same question with one read of
 * the list's own table, scoped in SQL to the caller's reach.
 *
 * Reach: the workspace listing's own rule (lib/workspace-access.ts
 * `listReachableWorkspaceIds`), narrowed for a per-task token to its own
 * workspace, the same as GET /api/tasks. The per-workspace routes' access
 * checks agree with it by construction.
 *
 * Rows are small: an artifact carries a 200-character content preview (the
 * whole body is `GET /api/artifacts/[id]`), a skill carries no body.
 * Query:
 *   artifacts: missionId, key, type, review=true, limit (default 20, max 50), newest first.
 *   schedules: every schedule, newest first.
 *   skills:    enabled=true|false, isRole=true|false; team-level rows once.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts, taskSchedules, workspaceSkills, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { listReachableWorkspaceIds } from '@/lib/workspace-access';
import { reviewArtifactScope } from '@/lib/artifact-scope';
import { appBaseUrl } from '@/lib/app-url';
import { isUuid } from '@/lib/uuid';

const LISTS = ['artifacts', 'schedules', 'skills'] as const;
type List = (typeof LISTS)[number];

export const ARTIFACT_PREVIEW_CHARS = 200;
const ARTIFACT_DEFAULT_LIMIT = 20;
const ARTIFACT_MAX_LIMIT = 50;

export async function GET(req: NextRequest, { params }: { params: Promise<{ list: string }> }) {
  const { list } = await params;
  if (!(LISTS as readonly string[]).includes(list)) {
    return NextResponse.json({ error: `list must be one of: ${LISTS.join(', ')}` }, { status: 404 });
  }
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  const user = account ? null : await getCurrentUser();
  if (!account && !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    let workspaceIds = await listReachableWorkspaceIds(account ? { account } : { userId: user!.id });
    if (account) workspaceIds = workspaceIds.filter(id => taskScopeAllowsWorkspace(account, id));
    if (workspaceIds.length === 0) return NextResponse.json({ workspaceCount: 0, [list]: [] });
    const sp = req.nextUrl.searchParams;
    const rows = await LOADERS[list as List](workspaceIds, sp);
    if (rows instanceof NextResponse) return rows;
    return NextResponse.json({ workspaceCount: workspaceIds.length, [list]: rows });
  } catch (err) {
    console.error(`[workspaces/across/${list}] failed:`, err);
    return NextResponse.json({ error: `Failed to list ${list}` }, { status: 500 });
  }
}

const LOADERS: Record<List, (workspaceIds: string[], sp: URLSearchParams) => Promise<unknown[] | NextResponse>> = {
  async artifacts(workspaceIds, sp) {
    const missionId = sp.get('missionId');
    if (missionId && !isUuid(missionId)) {
      return NextResponse.json({ error: `Invalid missionId: expected a UUID, got "${missionId}".` }, { status: 400 });
    }
    const limit = Math.min(Math.max(parseInt(sp.get('limit') || String(ARTIFACT_DEFAULT_LIMIT), 10) || ARTIFACT_DEFAULT_LIMIT, 1), ARTIFACT_MAX_LIMIT);
    const where: SQL[] = [inArray(artifacts.workspaceId, workspaceIds)];
    if (missionId) where.push(eq(artifacts.missionId, missionId));
    const key = sp.get('key');
    if (key) where.push(eq(artifacts.key, key));
    const type = sp.get('type');
    if (type) where.push(eq(artifacts.type, type));
    if (sp.get('review') === 'true') where.push(reviewArtifactScope());
    const rows = await db.select({
      id: artifacts.id, title: artifacts.title, type: artifacts.type, key: artifacts.key,
      workspaceId: artifacts.workspaceId, workspaceName: workspaces.name, missionId: artifacts.missionId,
      updatedAt: artifacts.updatedAt, visibility: artifacts.visibility, shareToken: artifacts.shareToken,
      // One more than the preview, so a reader can tell it was cut.
      content: sql<string | null>`left(${artifacts.content}, ${ARTIFACT_PREVIEW_CHARS + 1})`,
    }).from(artifacts)
      .leftJoin(workspaces, eq(workspaces.id, artifacts.workspaceId))
      .where(and(...where))
      .orderBy(desc(artifacts.updatedAt))
      .limit(limit);
    const base = appBaseUrl();
    return rows.map(({ shareToken, ...a }) => ({
      ...a,
      shareUrl: shareToken && a.visibility === 'public' ? `${base}/share/${shareToken}` : null,
    }));
  },

  async schedules(workspaceIds) {
    const rows = await db.select({ schedule: taskSchedules, workspaceName: workspaces.name })
      .from(taskSchedules)
      .leftJoin(workspaces, eq(workspaces.id, taskSchedules.workspaceId))
      .where(inArray(taskSchedules.workspaceId, workspaceIds))
      .orderBy(desc(taskSchedules.createdAt));
    return rows.map(r => ({ ...r.schedule, workspaceName: r.workspaceName }));
  },

  async skills(workspaceIds, sp) {
    const filters: SQL[] = [];
    const enabled = sp.get('enabled');
    if (enabled === 'true' || enabled === 'false') filters.push(eq(workspaceSkills.enabled, enabled === 'true'));
    const isRole = sp.get('isRole');
    if (isRole === 'true' || isRole === 'false') filters.push(eq(workspaceSkills.isRole, isRole === 'true'));
    const teamsOf = db.select({ teamId: workspaces.teamId }).from(workspaces).where(inArray(workspaces.id, workspaceIds));
    // Personal roles are listed by GET /api/roles, never here (as the per-workspace route).
    const scope = or(
      inArray(workspaceSkills.workspaceId, workspaceIds),
      and(isNull(workspaceSkills.workspaceId), inArray(workspaceSkills.teamId, teamsOf), isNull(workspaceSkills.ownerUserId)),
    )!;
    return db.select({
      id: workspaceSkills.id, slug: workspaceSkills.slug, name: workspaceSkills.name, description: workspaceSkills.description,
      workspaceId: workspaceSkills.workspaceId, workspaceName: workspaces.name, isRole: workspaceSkills.isRole,
      enabled: workspaceSkills.enabled, model: workspaceSkills.model, mcpServers: workspaceSkills.mcpServers,
    }).from(workspaceSkills)
      .leftJoin(workspaces, eq(workspaces.id, workspaceSkills.workspaceId))
      .where(filters.length > 0 ? and(scope, ...filters) : scope)
      .orderBy(desc(workspaceSkills.createdAt));
  },
};
