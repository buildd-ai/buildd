import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaceSkills, workers, tasks } from '@buildd/core/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserWorkspaceIds } from '@/lib/team-access';

// GET /api/roles — list roles with current load
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    let wsIds: string[];
    if (apiAccount) {
      // For API key auth, get workspace IDs from the account's team
      wsIds = await getUserWorkspaceIds(apiAccount.id);
    } else {
      wsIds = await getUserWorkspaceIds(user!.id);
    }

    if (wsIds.length === 0) {
      return NextResponse.json({ roles: [] });
    }

    // Get all enabled roles, dedupe by slug
    const allRoles = await db.query.workspaceSkills.findMany({
      where: and(
        inArray(workspaceSkills.workspaceId, wsIds),
        eq(workspaceSkills.isRole, true),
        eq(workspaceSkills.enabled, true),
      ),
      columns: {
        slug: true,
        name: true,
        model: true,
        color: true,
        description: true,
      },
    });

    // Deduplicate by slug
    const seenSlugs = new Set<string>();
    const uniqueRoles = allRoles.filter(r => {
      if (seenSlugs.has(r.slug)) return false;
      seenSlugs.add(r.slug);
      return true;
    });

    // Count active workers per role slug
    const activeWorkerCounts = await db
      .select({
        roleSlug: tasks.roleSlug,
        count: sql<number>`count(distinct ${workers.id})::int`,
      })
      .from(workers)
      .innerJoin(tasks, eq(workers.taskId, tasks.id))
      .where(
        and(
          inArray(workers.workspaceId, wsIds),
          inArray(workers.status, ['running', 'starting', 'waiting_input']),
        )
      )
      .groupBy(tasks.roleSlug);

    const loadMap: Record<string, number> = {};
    for (const row of activeWorkerCounts) {
      if (row.roleSlug) {
        loadMap[row.roleSlug] = row.count;
      }
    }

    const roles = uniqueRoles.map(r => ({
      slug: r.slug,
      name: r.name,
      model: r.model,
      color: r.color,
      description: r.description,
      currentLoad: loadMap[r.slug] || 0,
      available: !loadMap[r.slug],
    }));

    return NextResponse.json({ roles });
  } catch (error) {
    console.error('GET /api/roles error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
