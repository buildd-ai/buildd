import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { computeUsageStats, describeScan, parseWindowMs } from '@/lib/usage-stats';
import { fetchUsageRows, USAGE_ROW_LIMIT } from '@/lib/usage-stats-query';
import { fetchCbmSummary } from '@/lib/cbm-insight-query';
import { buildUsageDrilldownView, resolveDrilldownWindow } from '@/lib/usage-drilldown';
import { UsageClient } from './UsageClient';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * `/app/health/usage` — what a task costs, and where the turns go.
 *
 * A tuning surface, not a daily glance: opened when changing a role prompt, a
 * tool policy or a tier. Health answers "is the fleet all right"; this answers
 * "what is a task made of", which is why the two carry different sections rather
 * than the same numbers at two sizes.
 *
 * The page is TASK-KEYED — every section reads the `aggregateByTask` fold, so a
 * task retried three times is one task costing the sum of its attempts. The one
 * exception declares itself at the stat (see `indexAdoptionLine`).
 */
export default async function UsageDrilldownPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; window?: string }>;
}) {
  const { workspace: wsFilter, window: rawWindow } = await searchParams;
  // 7d | 30d only. A 24h header window clamps to 7d with a visible notice; the
  // clamp is local and never rewrites Health's `?window=`, so browser-back lands
  // on Health at 24h with no state to reconcile.
  const resolution = resolveDrilldownWindow(rawWindow);

  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="hidden md:block text-2xl font-bold mb-2">Usage</h1>
        <p className="text-sm text-text-tertiary">No team found. <Link href="/app/teams/new" className="text-primary hover:underline">Create a team</Link> to see this page.</p>
      </div>
    );
  }

  const cookieStore = await cookies();
  const activeTeamId =
    (await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value)) ?? teamIds[0];

  const teamWorkspaceRows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.teamId, activeTeamId));

  const teamWorkspaceIds = (teamWorkspaceRows as any[]).map((w: any) => w.id as string);
  if (teamWorkspaceIds.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="hidden md:block text-2xl font-bold mb-2">Usage</h1>
        <p className="text-sm text-text-tertiary">No workspaces yet.</p>
      </div>
    );
  }

  const scopedWsIds = wsFilter && teamWorkspaceIds.includes(wsFilter) ? [wsFilter] : teamWorkspaceIds;

  const windowMs = parseWindowMs(resolution.window);
  const now = Date.now();
  const windowStart = new Date(now - windowMs);
  // The comparison period is the window immediately before this one, same
  // length, read as its own capped scan rather than as the tail of a doubled
  // one — a single 2×-window scan would truncate the OLDER half first and turn
  // every delta into an artefact of the cap.
  const previousStart = new Date(now - 2 * windowMs);

  const [rows, previousRows, cbm] = await Promise.all([
    fetchUsageRows({ workspaceIds: scopedWsIds, windowStart }).catch(() => []),
    fetchUsageRows({ workspaceIds: scopedWsIds, windowStart: previousStart, windowEnd: windowStart })
      .catch(() => []),
    fetchCbmSummary({ workspaceIds: scopedWsIds, window: resolution.window, windowStart })
      .catch(() => null),
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
    cbm,
  });

  return (
    <UsageClient
      view={view}
      teamWorkspaces={(teamWorkspaceRows as any[]).map((w: any) => ({ id: w.id as string, name: w.name as string }))}
      wsFilter={wsFilter ?? null}
    />
  );
}
