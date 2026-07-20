import { redirect } from 'next/navigation';
import { inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces as workspacesTable } from '@buildd/core/db/schema';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { isSystemWorkspace } from '@buildd/shared';
import ConnectionsClient from './ConnectionsClient';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/app/auth/signin');
  }

  const { connected, error } = await searchParams;

  // Workspaces for the owning team — feeds the Add Connection modal's "One workspace"
  // scope. Connectors are created under the user's first team (see POST /api/connectors),
  // so scope options must be drawn from that same team for the server-side validation.
  const [teamIds, wsIds] = await Promise.all([
    getUserTeamIds(user.id),
    getUserWorkspaceIds(user.id),
  ]);
  const teamId = teamIds[0] ?? null;
  const rows = wsIds.length > 0
    ? await db.query.workspaces.findMany({
        where: inArray(workspacesTable.id, wsIds),
        columns: { id: true, name: true, teamId: true },
      })
    : [];
  const teamWorkspaces = rows
    .filter((w) => (teamId ? w.teamId === teamId : true) && !isSystemWorkspace(w.name))
    .map((w) => ({ id: w.id, name: w.name }));

  return (
    <ConnectionsClient connectedId={connected} errorMsg={error} workspaces={teamWorkspaces} />
  );
}
