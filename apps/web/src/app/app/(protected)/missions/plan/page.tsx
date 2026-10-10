import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { and, eq, isNull, or } from 'drizzle-orm';
import { missions } from '@buildd/core/db/schema';
import { taskEstimatesEnabled } from '@buildd/core/task-estimate-source';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { loadMissionPlan } from '@/lib/mission-plan-source';
import { PlanError, PlanOff, PlanReady, PlanShell } from './MissionPlanView';

export const dynamic = 'force-dynamic';

/**
 * Plan: when open missions should land, for someone who needs the update and
 * not the controls. Reached from the Missions list ("Plan ›"), behind the
 * team's task-estimates switch.
 */
export default async function MissionPlanPage({ searchParams }: { searchParams: Promise<{ workspace?: string }> }) {
  const { workspace: wsFilter } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) redirect('/app/missions');
  const cookieStore = await cookies();
  const activeTeamId = (await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value)) ?? teamIds[0];

  if (!(await taskEstimatesEnabled(activeTeamId))) {
    return <PlanShell><PlanOff /></PlanShell>;
  }

  const missionsWhere = wsFilter
    ? and(eq(missions.teamId, activeTeamId), or(eq(missions.workspaceId, wsFilter), isNull(missions.workspaceId)))
    : eq(missions.teamId, activeTeamId);

  const now = Date.now();
  let loaded: Awaited<ReturnType<typeof loadMissionPlan>>;
  try {
    loaded = await loadMissionPlan(missionsWhere, now);
  } catch (err) {
    console.error('[plan] load failed', err);
    return <PlanShell><PlanError /></PlanShell>;
  }
  return <PlanShell><PlanReady inputs={loaded.inputs} plans={loaded.plans} now={now} /></PlanShell>;
}
