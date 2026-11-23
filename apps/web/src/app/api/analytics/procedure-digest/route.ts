import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaceSkills } from '@buildd/core/db/schema';
import { and, desc, eq, gte, isNotNull, or, isNull } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { sqlWhere, sqlOrderBy } from '@buildd/core/db/relational-sql';
import { procedureDigest, digestSourceFromMilestones, type DigestWindow } from '../procedure-digest';

const WINDOW_MS: Record<DigestWindow, number> = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };

// GET /api/analytics/procedure-digest?workspaceId=&window=24h|7d|30d&limit=
// Verified (PR-merged) tasks of one workspace, as procedureDigest() shapes them.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  const window = (url.searchParams.get('window') ?? '30d') as DigestWindow;
  if (!(window in WINDOW_MS)) return NextResponse.json({ error: 'window must be 24h, 7d or 30d' }, { status: 400 });
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200));

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const allowed =
    apiAccount && !user
      ? taskScopeAllowsWorkspace(apiAccount, workspaceId) && (await verifyAccountWorkspaceAccess(apiAccount, workspaceId))
      : !!(await verifyWorkspaceAccess(user!.id, workspaceId));
  if (!allowed) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  const skills = await db.query.workspaceSkills.findMany({
    where: sqlWhere(or(eq(workspaceSkills.workspaceId, workspaceId), isNull(workspaceSkills.workspaceId))),
    columns: { slug: true },
  });

  const rows = await procedureDigest({
    workspaceId,
    callerWorkspaceIds: [workspaceId],
    window,
    limit,
    registeredSkillSlugs: skills.map((s) => s.slug),
    load: async ({ workspaceId: ws, window: w, limit: n }) => {
      const since = new Date(Date.now() - WINDOW_MS[w]);
      const found = await db.query.workers.findMany({
        where: sqlWhere(and(eq(workers.workspaceId, ws), isNotNull(workers.mergedAt), isNotNull(workers.taskId), gte(workers.mergedAt, since))),
        orderBy: sqlOrderBy([desc(workers.mergedAt)]),
        limit: n,
        columns: { taskId: true, milestones: true },
        with: { task: { columns: { roleSlug: true } } },
      });
      return found.map((r) => {
        const { toolCalls, skillsLoaded } = digestSourceFromMilestones(r.milestones);
        return { id: r.taskId!, roleSlug: (r as any).task?.roleSlug ?? null, verifiedBasis: 'pr_merged', toolCalls, skillsLoaded };
      });
    },
  });
  return NextResponse.json({ workspaceId, window, rows });
}
