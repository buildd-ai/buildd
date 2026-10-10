import { cookies } from 'next/headers';
import { inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { displayWorkspaceName } from '@buildd/shared';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { isPaused } from '@/lib/workspace-pause';
import WorkspacePausePanel from '@/components/WorkspacePausePanel';
import { renderHealthPage } from '../_lib/render-health';

export const dynamic = 'force-dynamic';

/** The active team's workspaces with their "pause new starts" state, for the control on this page. */
async function pauseRows() {
  const user = await getCurrentUser();
  if (!user) return [];
  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) return [];
  const activeTeamId = (await resolveActiveTeamId(user.id, (await cookies()).get('buildd-team')?.value)) ?? teamIds[0];
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, until: workspaces.newStartsPausedUntil })
    .from(workspaces)
    .where(inArray(workspaces.teamId, [activeTeamId]));
  const now = new Date();
  return rows.map(r => ({
    id: r.id,
    name: displayWorkspaceName(r.name),
    pausedUntil: isPaused(r.until, now) ? new Date(r.until!).toISOString() : null,
  }));
}

/** `/app/health/runners`: Runners & capacity: slots in use, runners, budget and credentials. Reads `?workspace=`. */
export default async function HealthRunnersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; window?: string; failureWindow?: string }> }) {
  const [rows, sp] = await Promise.all([pauseRows(), searchParams]);
  return renderHealthPage('runners', searchParams, <WorkspacePausePanel workspaces={rows} defaultWorkspaceId={sp.workspace ?? null} />);
}
