import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { and, eq, isNull, or } from 'drizzle-orm';
import { missions } from '@buildd/core/db/schema';
import { taskEstimatesEnabled } from '@buildd/core/task-estimate-source';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { loadMissionPlan } from '@/lib/mission-plan-source';
import { planAxis, planLede, planMissions } from '@/lib/mission-plan';
import MissionPlanChart from './MissionPlanChart';

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

  const back = (
    <Link href="/app/missions" className="text-meta text-text-muted hover:text-text-secondary">‹ Missions</Link>
  );
  const shell = (children: React.ReactNode) => (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 pb-10 max-w-[1180px]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 data-testid="plan-headline" className="sr-only md:not-sr-only text-heading font-semibold text-text-primary">Plan</h1>
        {back}
      </div>
      {children}
    </div>
  );

  if (!(await taskEstimatesEnabled(activeTeamId))) {
    return shell(
      <p data-testid="plan-off" className="text-body text-text-secondary">
        Plan needs task estimates, which are off for this team. Turn them on in team settings and finish dates will show here.
      </p>,
    );
  }

  const missionsWhere = wsFilter
    ? and(eq(missions.teamId, activeTeamId), or(eq(missions.workspaceId, wsFilter), isNull(missions.workspaceId)))
    : eq(missions.teamId, activeTeamId);

  const now = Date.now();
  const { inputs, plans } = await loadMissionPlan(missionsWhere, now);
  const rows = planMissions(inputs, now, plans);
  const lede = planLede(rows, plans, now);
  const cuts = [...plans.values()].flatMap(p => (p.mode === 'cuts' ? p.cuts : [])).filter(c => c >= now);
  const axis = planAxis(rows, cuts, now);
  const visibleCuts = cuts.filter(c => c <= axis.to);

  return shell(
    <>
      <p data-testid="plan-lede" className="font-voice text-[22px] leading-snug text-text-primary max-w-prose">{lede.headline}</p>
      {lede.detail && <p data-testid="plan-detail" className="mt-1 text-body text-text-secondary max-w-prose">{lede.detail}</p>}
      <div className="mt-6">
        {rows.length === 0 ? null : <MissionPlanChart rows={rows} axis={axis} cuts={visibleCuts} now={now} />}
      </div>
    </>,
  );
}
