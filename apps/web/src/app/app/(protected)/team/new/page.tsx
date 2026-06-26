import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, getUserTeamIds } from '@/lib/team-access';
import { TeamRoleForm } from './TeamRoleForm';

export const dynamic = 'force-dynamic';

export default async function NewTeamRolePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const [wsIds, teamIds] = await Promise.all([
    getUserWorkspaceIds(user.id),
    getUserTeamIds(user.id),
  ]);

  if (teamIds.length === 0) {
    redirect('/app/team');
  }

  const workspaceList = wsIds.length > 0
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
          teamId={teamIds[0]}
          workspaces={workspaceList}
        />
      </div>
    </main>
  );
}
