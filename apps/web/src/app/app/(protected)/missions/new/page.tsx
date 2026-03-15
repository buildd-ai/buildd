import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import NewMissionForm from './NewMissionForm';

export const dynamic = 'force-dynamic';

export default async function NewMissionPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const [teamIds, wsIds] = await Promise.all([
    getUserTeamIds(user.id),
    getUserWorkspaceIds(user.id),
  ]);

  if (teamIds.length === 0) {
    return (
      <div className="p-8 text-center text-text-secondary">
        No team found. Create a workspace to get started.
      </div>
    );
  }

  let teamWorkspaces: { id: string; name: string }[] = [];
  if (wsIds.length > 0) {
    teamWorkspaces = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, wsIds),
      columns: { id: true, name: true },
      orderBy: [desc(workspaces.createdAt)],
    });
  }

  return <NewMissionForm workspaces={teamWorkspaces} />;
}
