import { db } from '@buildd/core/db';
import { objectives, workspaces } from '@buildd/core/db/schema';
import { eq, inArray, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import ObjectivesList from './ObjectivesList';

export const dynamic = 'force-dynamic';

export default async function ObjectivesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  if (teamIds.length === 0) {
    return (
      <div className="p-8 text-center text-text-secondary">
        No team found. Create a workspace to get started.
      </div>
    );
  }

  const [allObjectives, teamWorkspaces] = await Promise.all([
    db.query.objectives.findMany({
      where: inArray(objectives.teamId, teamIds),
      orderBy: [desc(objectives.priority), desc(objectives.createdAt)],
      with: {
        workspace: { columns: { id: true, name: true } },
        // Most recent task for "last output" preview
        tasks: {
          columns: { id: true, status: true, result: true, updatedAt: true },
          orderBy: (tasks, { desc }) => [desc(tasks.updatedAt)],
          limit: 1,
        },
        schedule: {
          columns: { cronExpression: true, taskTemplate: true },
        },
      },
    }),
    db.query.workspaces.findMany({
      where: inArray(workspaces.teamId, teamIds),
      columns: { id: true, name: true },
      orderBy: [desc(workspaces.createdAt)],
    }),
  ]);

  const shaped = allObjectives.map(obj => {
    const lastTask = obj.tasks?.[0] ?? null;
    const result = lastTask?.result as { prUrl?: string; prNumber?: number; summary?: string } | null;
    return {
      id: obj.id,
      title: obj.title,
      description: obj.description,
      status: obj.status,
      priority: obj.priority,
      cronExpression: (obj.schedule as any)?.cronExpression || null,
      isHeartbeat: (obj.schedule as any)?.taskTemplate?.context?.heartbeat === true,
      workspaceId: obj.workspaceId,
      workspace: obj.workspace ?? null,
      lastOutput: lastTask
        ? {
            status: lastTask.status,
            updatedAt: lastTask.updatedAt.toISOString(),
            prUrl: result?.prUrl ?? null,
            prNumber: result?.prNumber ?? null,
          }
        : null,
    };
  });

  return (
    <div className="max-w-4xl mx-auto p-6">
      <ObjectivesList
        objectives={shaped}
        teamId={teamIds[0]}
        workspaces={teamWorkspaces}
      />
    </div>
  );
}
