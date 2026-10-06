import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { resolveActiveTeamId } from '@/lib/team-access';
import { computeUsageStats, describeScan, parseWindowMs } from '@/lib/usage-stats';
import { fetchUsageRows, USAGE_ROW_LIMIT } from '@/lib/usage-stats-query';
import {
  buildActionBreakdownPanel,
  buildUsageDrilldownView,
  resolveDrilldownWindow,
  type UsageDrilldownView,
} from '@/lib/usage-drilldown';
import {
  ACTION_EVENTS_CAPTURED_SINCE,
  ACTION_EVENTS_ROW_LIMIT,
  countWorkersInWindow,
  fetchActionEvents,
} from '@/lib/action-events';

export type UsageViewResult =
  | { kind: 'ok'; view: UsageDrilldownView; wsFilter: string | null }
  | { kind: 'no-workspaces' };

/**
 * The Usage drill-down's data, shared by Health → Usage (what a task costs) and
 * Health → Operator (where the turns go: code navigation, shell, buildd
 * actions). `includeInternals` loads the buildd action log only for the page
 * that shows it.
 */
export async function loadUsageView({
  userId,
  teamIds,
  searchParams,
  includeInternals,
}: {
  userId: string;
  teamIds: string[];
  searchParams: { workspace?: string; window?: string };
  includeInternals: boolean;
}): Promise<UsageViewResult> {
  const { workspace: wsFilter, window: rawWindow } = searchParams;
  // 7d | 30d only. A 24h header window clamps to 7d with a visible notice; the
  // clamp is local and never rewrites Health's `?window=`, so browser-back lands
  // on Health at 24h with no state to reconcile.
  const resolution = resolveDrilldownWindow(rawWindow);
  const cookieStore = await cookies();
  const activeTeamId =
    (await resolveActiveTeamId(userId, cookieStore.get('buildd-team')?.value)) ?? teamIds[0];

  const teamWorkspaceRows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.teamId, activeTeamId));

  const teamWorkspaceIds = (teamWorkspaceRows as any[]).map((w: any) => w.id as string);
  if (teamWorkspaceIds.length === 0) return { kind: 'no-workspaces' };

  const scopedWsIds = wsFilter && teamWorkspaceIds.includes(wsFilter) ? [wsFilter] : teamWorkspaceIds;

  const windowMs = parseWindowMs(resolution.window);
  const now = Date.now();
  const windowStart = new Date(now - windowMs);
  // The comparison period is the window immediately before this one, same
  // length, read as its own capped scan rather than as the tail of a doubled
  // one — a single 2×-window scan would truncate the OLDER half first and turn
  // every delta into an artefact of the cap.
  const previousStart = new Date(now - 2 * windowMs);

  const [rows, previousRows, actionRows, actionWorkers] = await Promise.all([
    fetchUsageRows({ workspaceIds: scopedWsIds, windowStart }).catch(() => []),
    fetchUsageRows({ workspaceIds: scopedWsIds, windowStart: previousStart, windowEnd: windowStart })
      .catch(() => []),
    // Guarded like every sibling: a failure here costs this one panel, not the
    // page. `null` from the pair below renders nothing rather than a zero.
    includeInternals ? fetchActionEvents({ workspaceIds: scopedWsIds, windowStart }).catch(() => null) : Promise.resolve(null),
    includeInternals ? countWorkersInWindow({ workspaceIds: scopedWsIds, windowStart }).catch(() => null) : Promise.resolve(null),
  ]);

  const previousScan = describeScan(previousRows, previousStart, USAGE_ROW_LIMIT);
  const view = buildUsageDrilldownView({
    resolution,
    current: computeUsageStats(rows, 'none'),
    // Always passed, even when empty: an empty previous period is a REASON
    // deltas are withheld ("only 0 tasks in the previous 7d"), which is a more
    // useful thing to render than a generic "nothing to compare against".
    previous: { stats: computeUsageStats(previousRows, 'none'), truncated: previousScan.truncated },
    scan: describeScan(rows, windowStart, USAGE_ROW_LIMIT),
    actions: actionRows && actionWorkers !== null
      ? buildActionBreakdownPanel({
          rows: actionRows,
          workers: actionWorkers,
          windowStart,
          capturedSince: ACTION_EVENTS_CAPTURED_SINCE,
          rowLimit: ACTION_EVENTS_ROW_LIMIT,
        })
      : null,
  });

  return { kind: 'ok', view, wsFilter: wsFilter ?? null };
}
