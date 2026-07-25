import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray, desc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds, resolveActiveTeamId } from '@/lib/team-access';
import NewInitiativeForm from './NewInitiativeForm';

export const dynamic = 'force-dynamic';

export default async function NewInitiativePage() {
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

  const cookieStore = await cookies();
  const activeTeamId =
    (await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value)) ?? teamIds[0];

  let teamWorkspaces: { id: string; name: string }[] = [];
  if (wsIds.length > 0) {
    teamWorkspaces = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, wsIds),
      columns: { id: true, name: true },
      orderBy: [desc(workspaces.createdAt)],
    });
  }

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8">
      <NewInitiativeForm teamId={activeTeamId} workspaces={teamWorkspaces} />
    </div>
  );
}
