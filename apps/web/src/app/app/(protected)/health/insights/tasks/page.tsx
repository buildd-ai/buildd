import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import TasksPage from '../../../tasks/page';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId, getTeamWorkspaceIds } from '@/lib/team-access';
import { insightsTaskListFilter } from '@/lib/insights-task-list-filter';

/** Insights owns historical band selection; core renders the scoped task list. */
export default async function InsightsTasksPage({ searchParams }: {
  searchParams: Promise<{ band?: string; from?: string; to?: string; at?: string; workspace?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/api/auth/signin');
  const cookieStore = await cookies();
  const teamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);
  if (!teamId) redirect('/app/health/insights');
  const teamWsIds = await getTeamWorkspaceIds(teamId);
  const workspaceIds = params.workspace && teamWsIds.includes(params.workspace) ? [params.workspace] : teamWsIds;
  const selection = await insightsTaskListFilter({ params, userId: user.id, teamId, workspaceIds });
  if (!selection) redirect('/app/tasks');
  return TasksPage({ searchParams: Promise.resolve({ workspace: params.workspace, ids: selection.ids, selection: selection.label }) });
}
