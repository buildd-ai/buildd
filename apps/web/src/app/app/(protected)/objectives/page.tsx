import { db } from '@buildd/core/db';
import { objectives, workspaces } from '@buildd/core/db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import ObjectivesList from './ObjectivesList';

export const dynamic = 'force-dynamic';

export default async function ObjectivesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="p-8 text-center text-text-secondary">
        No team found. Create a team to get started.
      </div>
    );
  }

  const { status: statusFilter } = await searchParams;
  const effectiveFilter = statusFilter || 'active';

  let where: any = inArray(objectives.teamId, teamIds);
  if (effectiveFilter !== 'all') {
    where = and(where, eq(objectives.status, effectiveFilter as any));
  }

  const [allObjectives, teamWorkspaces] = await Promise.all([
    db.query.objectives.findMany({
      where,
      orderBy: [desc(objectives.priority), desc(objectives.createdAt)],
      with: {
        workspace: { columns: { id: true, name: true } },
        tasks: { columns: { id: true, status: true } },
      },
    }),
    db.query.workspaces.findMany({
      where: inArray(workspaces.teamId, teamIds),
      columns: { id: true, name: true },
      orderBy: [desc(workspaces.createdAt)],
    }),
  ]);

  const objectivesWithProgress = allObjectives.map(obj => {
    const totalTasks = obj.tasks?.length || 0;
    const completedTasks = obj.tasks?.filter(t => t.status === 'completed').length || 0;
    const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    return { ...obj, totalTasks, completedTasks, progress };
  });

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Objectives</h1>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 mb-6 border-b border-border-default">
        {['active', 'paused', 'completed', 'all'].map(tab => {
          const isActive = effectiveFilter === tab;
          return (
            <Link
              key={tab}
              href={`/app/objectives${tab === 'active' ? '' : `?status=${tab}`}`}
              className={`px-3 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {tab}
            </Link>
          );
        })}
      </div>

      <ObjectivesList
        objectives={objectivesWithProgress}
        teamId={teamIds[0]}
        workspaces={teamWorkspaces}
      />
    </div>
  );
}
