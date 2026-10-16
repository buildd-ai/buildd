import { cookies } from 'next/headers';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { displayWorkspaceName } from '@buildd/shared';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import WorkspacePauseBanners from '@/components/WorkspacePauseBanners';
import { renderHealthPage } from '../_lib/render-health';

export const dynamic = 'force-dynamic';

/**
 * The active team's workspaces whose new starts are paused right now. Health
 * only shows a pause; pausing and resuming live on each workspace's settings
 * page (Where work runs), under manage_workspace_settings.
 */
async function pausedRows() {
  const user = await getCurrentUser();
  if (!user) return [];
  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) return [];
  const activeTeamId = (await resolveActiveTeamId(user.id, (await cookies()).get('buildd-team')?.value)) ?? teamIds[0];
  if (!teamIds.includes(activeTeamId)) return [];
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, until: workspaces.newStartsPausedUntil })
    .from(workspaces)
    .where(and(eq(workspaces.teamId, activeTeamId), gt(workspaces.newStartsPausedUntil, new Date())))
    .catch(() => []);
  return rows.map(r => ({ id: r.id, name: displayWorkspaceName(r.name), pausedUntil: new Date(r.until!).toISOString() }));
}

/** `/app/health/runners`: Runners & capacity: slots in use, runners, budget and credentials. Reads `?workspace=`. */
export default async function HealthRunnersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  const rows = await pausedRows();
  return renderHealthPage('runners', searchParams, <WorkspacePauseBanners workspaces={rows} />);
}
