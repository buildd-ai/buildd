import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds } from '@/lib/team-access';
import {
  computeUsageStats,
  describeScan,
  parseWindowMs,
  parseRoleGroupKey,
  INFERRED_ROLE_SUFFIX,
  USAGE_WINDOWS,
  type GroupDimension,
} from '@/lib/usage-stats';
import { fetchUsageRows, USAGE_ROW_LIMIT } from '@/lib/usage-stats-query';
import {
  ACTION_EVENTS_CAPTURED_SINCE,
  ACTION_EVENTS_ROW_LIMIT,
  countWorkersInWindow,
  fetchActionEvents,
} from '@/lib/action-events';
import { buildActionBreakdownPanel, type ActionBreakdownPanel } from '@/lib/usage-drilldown';

const GROUP_DIMENSIONS: GroupDimension[] = ['role', 'workspace', 'creationSource', 'none', 'executor'];

/** Labels for `groupBy=executor` keys (see `executorOf`). */
const EXECUTOR_LABELS: Record<string, string> = {
  interactive: 'Interactive (MCP session)',
  runner: 'Runner',
  other: 'Other (system / external / OpenClaw)',
};

/**
 * GET /api/stats/usage
 *
 * Per-team / per-workspace consumption stats: tokens, cost, turns and tool
 * calls per task, grouped by role or workspace.
 *
 * Query params:
 *   window    - "24h" | "7d" | "30d" (default "7d")
 *   workspace - workspaceId filter (optional; must be one the caller can see)
 *   groupBy   - "role" | "workspace" | "creationSource" | "executor" | "none" (default "role").
 *               "executor" splits workers claimed from an interactive MCP
 *               session (workers.runner = 'mcp') from runner-claimed ones.
 *
 * The health page's role block answers "did work land". This answers "what did
 * it cost" — median/p90 tokens per task, cost, turns, and which tools agents
 * actually reach for. Read every tool number against `tools.coverage`: exact
 * histograms only exist for workers that ran after the histogram shipped.
 *
 * Three finer breakdowns, each on its OWN population (never one ratio across
 * two of them):
 *   bashBuckets / searchShapes — what the Bash calls were for, over tasks with
 *     an exact histogram only (`tools.coverage.histogram`).
 *   buildActions — per-action buildd MCP calls from worker_action_events, over
 *     workers in the window; recorded since `capturedSince`, no backfill.
 * `buildActions` is null when its read failed or found nothing.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token reads usage only for its own task's workspace.
  const apiAccount = apiKey ? await authenticateTaskScopedCaller(apiKey, req) : null;

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawWindow = url.searchParams.get('window');
  if (rawWindow !== null && !(USAGE_WINDOWS as readonly string[]).includes(rawWindow)) {
    return NextResponse.json(
      { error: `Invalid window: "${rawWindow}". Expected one of ${USAGE_WINDOWS.join(', ')}.` },
      { status: 400 },
    );
  }
  const windowParam = rawWindow ?? '7d';
  const workspaceParam = url.searchParams.get('workspace');
  const groupByParam = url.searchParams.get('groupBy') ?? 'role';
  const groupBy: GroupDimension = GROUP_DIMENSIONS.includes(groupByParam as GroupDimension)
    ? (groupByParam as GroupDimension)
    : 'role';

  const windowStart = new Date(Date.now() - parseWindowMs(windowParam));

  // Both auth types resolve to the same team scope, so an API key can't read a
  // team it isn't on even when it passes an explicit ?workspace=.
  const teamIds = await resolveAccountTeamIds(user, apiAccount ?? null);
  const teamWorkspaces = teamIds.length > 0
    ? await db.query.workspaces.findMany({
        where: inArray(workspaces.teamId, teamIds),
        columns: { id: true, name: true },
      })
    : [];
  // A task token's team is narrowed to its task's workspace before anything
  // reads it: totals, groups and workspace labels never cover the rest.
  const scopedWorkspaces = apiAccount
    ? teamWorkspaces.filter(w => taskScopeAllowsWorkspace(apiAccount, w.id))
    : teamWorkspaces;
  const allowedIds = scopedWorkspaces.map(w => w.id);

  if (workspaceParam && !allowedIds.includes(workspaceParam)) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  const workspaceIds = workspaceParam ? [workspaceParam] : allowedIds;
  if (workspaceIds.length === 0) {
    return NextResponse.json(emptyResponse(windowParam, windowStart, groupBy));
  }

  const [usageRows, buildActions] = await Promise.all([
    fetchUsageRows({ workspaceIds, windowStart }),
    // Each guarded on its own: a failure costs that breakdown, not the response.
    readBuildActions(workspaceIds, windowStart).catch(() => null),
  ]);
  const stats = computeUsageStats(usageRows, groupBy);
  const labels = await groupLabels(stats.groups.map(g => g.key), groupBy, workspaceIds, scopedWorkspaces);
  const scan = describeScan(usageRows, windowStart, USAGE_ROW_LIMIT);

  return NextResponse.json({
    window: windowParam,
    windowStart: windowStart.toISOString(),
    workspaceIds,
    /** True when the row cap was hit — totals are then a floor, not a total. */
    truncatedScan: scan.truncated,
    /**
     * What the numbers below are actually computed over. On a truncated scan the
     * rows are the newest `limit` workers, so they are the COMPLETE population
     * of [completeSince, now) and an incomplete one for the requested window:
     * read the totals as a floor and every distribution as covering
     * `completeSince` onward, not `windowStart` onward.
     */
    scan,
    ...stats,
    groups: stats.groups.map(g => ({ ...g, label: labels[g.key] ?? g.key })),
    buildActions,
  });
}

async function readBuildActions(workspaceIds: string[], windowStart: Date): Promise<ActionBreakdownPanel> {
  const [rows, workers] = await Promise.all([
    fetchActionEvents({ workspaceIds, windowStart }),
    countWorkersInWindow({ workspaceIds, windowStart }),
  ]);
  return buildActionBreakdownPanel({
    rows,
    workers,
    windowStart,
    capturedSince: ACTION_EVENTS_CAPTURED_SINCE,
    rowLimit: ACTION_EVENTS_ROW_LIMIT,
  });
}

/**
 * Human labels for group keys: role slugs → role names (+ color, for the health
 * page chips), workspace ids → workspace names. creationSource keys (dashboard,
 * api, mcp, ...) are already human-readable, so they're returned as-is by the
 * route's `labels[g.key] ?? g.key` fallback — looking them up against the roles
 * table would risk a false-positive match if a role slug ever collided with one.
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
  if (groupBy === 'executor') return EXECUTOR_LABELS;
  if (groupBy === 'creationSource') return {};

  // A routed role's group is `<slug> · inferred`; look the slug up and keep the suffix.
  const parsed = keys.map(k => ({ key: k, ...parseRoleGroupKey(k) }));
  const slugs = [...new Set(parsed.map(p => p.roleSlug).filter((s): s is string => !!s))];
  if (slugs.length === 0) return {};
  const skills = await db.query.workspaceSkills.findMany({
    where: and(
      inArray(workspaceSkills.workspaceId, workspaceIds),
      eq(workspaceSkills.isRole, true),
      inArray(workspaceSkills.slug, slugs),
    ),
    columns: { slug: true, name: true },
  });
  const nameBySlug = new Map((skills as any[]).map(s => [s.slug as string, s.name as string]));
  return Object.fromEntries(parsed
    .filter(p => p.roleSlug && nameBySlug.has(p.roleSlug))
    .map(p => [p.key, `${nameBySlug.get(p.roleSlug!)}${p.roleSource === 'inferred' ? INFERRED_ROLE_SUFFIX : ''}`]));
}

function emptyResponse(window: string, windowStart: Date, groupBy: GroupDimension) {
  const stats = computeUsageStats([], groupBy);
  return {
    window,
    windowStart: windowStart.toISOString(),
    workspaceIds: [] as string[],
    truncatedScan: false,
    scan: { rows: 0, limit: USAGE_ROW_LIMIT, truncated: false, completeSince: windowStart.toISOString() },
    ...stats,
    groups: [] as unknown[],
    buildActions: null,
  };
}
