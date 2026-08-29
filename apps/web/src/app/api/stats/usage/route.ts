import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds } from '@/lib/team-access';
import {
  computeUsageStats,
  parseWindowMs,
  UNASSIGNED_ROLE,
  type GroupDimension,
} from '@/lib/usage-stats';
import { fetchUsageRows, USAGE_ROW_LIMIT } from '@/lib/usage-stats-query';

const GROUP_DIMENSIONS: GroupDimension[] = ['role', 'workspace', 'none'];

/**
 * GET /api/stats/usage
 *
 * Per-team / per-workspace consumption stats: tokens, cost, turns and tool
 * calls per task, grouped by role or workspace.
 *
 * Query params:
 *   window    - "24h" | "7d" | "30d" (default "7d")
 *   workspace - workspaceId filter (optional; must be one the caller can see)
 *   groupBy   - "role" | "workspace" | "none" (default "role")
 *
 * The health page's role block answers "did work land". This answers "what did
 * it cost" — median/p90 tokens per task, cost, turns, and which tools agents
 * actually reach for. Read every tool number against `tools.coverage`: exact
 * histograms only exist for workers that ran after the histogram shipped.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = apiKey ? await authenticateApiKey(apiKey) : null;

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const windowParam = url.searchParams.get('window') ?? '7d';
  const workspaceParam = url.searchParams.get('workspace');
  const groupByParam = url.searchParams.get('groupBy') ?? 'role';
  const groupBy: GroupDimension = GROUP_DIMENSIONS.includes(groupByParam as GroupDimension)
    ? (groupByParam as GroupDimension)
    : 'role';

  const windowStart = new Date(Date.now() - parseWindowMs(windowParam));

  // Both auth types resolve to the same team scope, so an API key can't read a
  // team it isn't on even when it passes an explicit ?workspace=.
  const teamIds = await resolveAccountTeamIds(user, apiAccount ?? null);
  const scopedWorkspaces = teamIds.length > 0
    ? await db.query.workspaces.findMany({
        where: inArray(workspaces.teamId, teamIds),
        columns: { id: true, name: true },
      })
    : [];
  const allowedIds = scopedWorkspaces.map(w => w.id);

  if (workspaceParam && !allowedIds.includes(workspaceParam)) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  const workspaceIds = workspaceParam ? [workspaceParam] : allowedIds;
  if (workspaceIds.length === 0) {
    return NextResponse.json(emptyResponse(windowParam, windowStart, groupBy));
  }

  const usageRows = await fetchUsageRows({ workspaceIds, windowStart });
  const stats = computeUsageStats(usageRows, groupBy);
  const labels = await groupLabels(stats.groups.map(g => g.key), groupBy, workspaceIds, scopedWorkspaces);

  return NextResponse.json({
    window: windowParam,
    windowStart: windowStart.toISOString(),
    workspaceIds,
    /** True when the row cap was hit — totals are then a floor, not a total. */
    truncatedScan: usageRows.length >= USAGE_ROW_LIMIT,
    ...stats,
    groups: stats.groups.map(g => ({ ...g, label: labels[g.key] ?? g.key })),
  });
}

/**
 * Human labels for group keys: role slugs → role names (+ color, for the health
 * page chips), workspace ids → workspace names.
 */
async function groupLabels(
  keys: string[],
  groupBy: GroupDimension,
  workspaceIds: string[],
  scopedWorkspaces: Array<{ id: string; name: string }>,
): Promise<Record<string, string>> {
  if (keys.length === 0) return {};

  if (groupBy === 'workspace') {
    return Object.fromEntries(scopedWorkspaces.map(w => [w.id, w.name]));
  }

  const slugs = keys.filter(k => k !== UNASSIGNED_ROLE);
  if (slugs.length === 0) return {};
  const skills = await db.query.workspaceSkills.findMany({
    where: and(
      inArray(workspaceSkills.workspaceId, workspaceIds),
      eq(workspaceSkills.isRole, true),
      inArray(workspaceSkills.slug, slugs),
    ),
    columns: { slug: true, name: true },
  });
  return Object.fromEntries((skills as any[]).map(s => [s.slug, s.name]));
}

function emptyResponse(window: string, windowStart: Date, groupBy: GroupDimension) {
  const stats = computeUsageStats([], groupBy);
  return {
    window,
    windowStart: windowStart.toISOString(),
    workspaceIds: [] as string[],
    truncatedScan: false,
    ...stats,
    groups: [] as unknown[],
  };
}
