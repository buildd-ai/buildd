import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { requirePlatformOperator } from '@/lib/operator-page';
import { resolveActiveTeamId, getTeamWorkspaceIds } from '@/lib/team-access';
import { insightsTaskListFilter } from '@/lib/insights-task-list-filter';
import { can } from '@/lib/permissions';
import { MISSION_WORKER_BASE_COLUMNS } from '@/lib/missions-query';
import BandTaskList from './BandTaskList';
import { bandRows, type BandTaskInput } from './band-rows';
import { resolveBandDrillQaState, sampleBandSelection } from './sample-band';

/** Insights owns historical band selection and lists it as Activity-style rows. Platform owner only, like Insights. */
export default async function InsightsTasksPage({ searchParams }: {
  searchParams: Promise<{ band?: string; from?: string; to?: string; at?: string; workspace?: string; state?: string }>;
}) {
  const params = await searchParams;
  const user = await requirePlatformOperator();
  const cookieStore = await cookies();
  const teamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);
  if (!teamId) redirect('/app/health/insights');
  // Dev-only fixture: synthetic band rows for the visual audit (./sample-band.ts).
  const qaState = resolveBandDrillQaState(params.state);
  if (qaState) {
    if (!(await can({ kind: 'user', userId: user.id }, 'view_team_usage', teamId))) redirect('/app/health/insights');
    const sample = sampleBandSelection(qaState, params.band);
    return <BandTaskList key={sample.label} label={sample.label} rows={bandRows(sample.tasks)} />;
  }
  const teamWsIds = await getTeamWorkspaceIds(teamId);
  const workspaceIds = params.workspace && teamWsIds.includes(params.workspace) ? [params.workspace] : teamWsIds;
  const selection = await insightsTaskListFilter({ params, userId: user.id, teamId, workspaceIds });
  if (!selection) redirect('/app/health/insights');
  const rows = selection.ids.length === 0 || workspaceIds.length === 0 ? [] : await db.query.tasks.findMany({
    where: and(inArray(tasks.id, selection.ids), inArray(tasks.workspaceId, workspaceIds)),
    columns: { id: true, title: true, status: true, updatedAt: true },
    with: {
      mission: { columns: { title: true } },
      workers: { columns: MISSION_WORKER_BASE_COLUMNS, limit: 5, orderBy: (w, { desc }) => [desc(w.startedAt)] },
    },
  });
  const inputs: BandTaskInput[] = rows.map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
    updatedAt: (t.updatedAt ?? new Date()).toISOString(),
    missionTitle: (t.mission as { title: string } | null)?.title ?? null,
    workers: t.workers ?? [],
  }));
  return <BandTaskList key={selection.label} label={selection.label} rows={bandRows(inputs)} />;
}
