import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
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
    redirect('/app/team');
  }

  const caller = { kind: 'user' as const, userId: user.id };
  const [createPersonal, manageTeam] = await Promise.all([
    can(caller, 'create_personal_roles', teamId).catch(() => false),
    can(caller, 'manage_agent_roles', teamId).catch(() => false),
  ]);
  const kinds = newRoleKinds({ createPersonal, manageTeam });
  const initialKind = initialRoleKind(kinds, requestedKind);
  if (!initialKind) redirect('/app/team');

  const workspaceList = manageTeam && wsIds.length > 0
    ? await db.query.workspaces.findMany({
        where: inArray(workspaces.id, wsIds),
        columns: { id: true, name: true },
      })
    : [];

  return (
    <main className="min-h-screen pt-4 px-4 pb-20 md:pt-8 md:px-8 md:pb-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-1.5 text-[13px] mb-5">
          <Link href="/app/team" className="text-text-muted hover:text-text-secondary">Team</Link>
          <span className="text-text-muted">/</span>
          <span className="text-text-primary font-medium">New Role</span>
        </div>
        <TeamRoleForm
          teamId={teamId}
          workspaces={workspaceList}
          kinds={kinds}
          initialKind={initialKind}
        />
      </div>
    </main>
  );
}
