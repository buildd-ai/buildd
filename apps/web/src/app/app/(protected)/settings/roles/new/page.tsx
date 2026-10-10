import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import SettingsPage from '../../_components/SettingsPage';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { can } from '@/lib/permissions';
import { initialRoleKind, newRoleKinds } from '@/lib/personal-roles-shared';
import { TeamRoleForm } from './TeamRoleForm';

export const dynamic = 'force-dynamic';

export default async function NewTeamRolePage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const cookieStore = await cookies();
  const [wsIds, teamIds, activeTeamId, { kind: requestedKind }] = await Promise.all([
    getUserWorkspaceIds(user.id),
    getUserTeamIds(user.id),
    resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value),
    searchParams,
  ]);

  // The same team POST /api/roles defaults to: the active one.
  const teamId = activeTeamId && teamIds.includes(activeTeamId) ? activeTeamId : teamIds[0];
  if (!teamId) {
    redirect('/app/settings/roles');
  }

  const caller = { kind: 'user' as const, userId: user.id };
  const [createPersonal, manageTeam] = await Promise.all([
    can(caller, 'create_personal_roles', teamId).catch(() => false),
    can(caller, 'manage_agent_roles', teamId).catch(() => false),
  ]);
  const kinds = newRoleKinds({ createPersonal, manageTeam });
  const initialKind = initialRoleKind(kinds, requestedKind);
  if (!initialKind) redirect('/app/settings/roles');

  const workspaceList = manageTeam && wsIds.length > 0
    ? await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true },
      })
    : [];

  return (
    <SettingsPage
      title={kinds.length === 1 && initialKind === 'personal' ? 'New role, just for you' : 'New role'}
      description="Define an agent persona with a model, tools, and instructions."
    >
      <TeamRoleForm
        teamId={teamId}
        workspaces={workspaceList}
        kinds={kinds}
        initialKind={initialKind}
      />
    </SettingsPage>
  );
}
