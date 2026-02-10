import { cookies } from 'next/headers';
import { AuthGuard } from '@/components/AuthGuard';
import { TeamSwitcher } from '@/components/TeamSwitcher';
import { getCurrentUser } from '@/lib/auth-helpers';
import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

async function getUserTeams(userId: string) {
  const memberships = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    with: {
      team: true,
    },
  });

  return memberships.map(m => ({
    id: m.team.id,
    name: m.team.name,
    slug: m.team.slug,
  }));
}

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  let userTeams: { id: string; name: string; slug: string }[] = [];
  let currentTeamId: string | null = null;

  if (user) {
    userTeams = await getUserTeams(user.id);

    const cookieStore = await cookies();
    const teamCookie = cookieStore.get('buildd-team')?.value;

    // Use cookie value if it matches a valid team, otherwise default to first team
    if (teamCookie && userTeams.some(t => t.id === teamCookie)) {
      currentTeamId = teamCookie;
    } else if (userTeams.length > 0) {
      currentTeamId = userTeams[0].id;
    }
  }

  return (
    <AuthGuard>
      {userTeams.length > 0 && (
        <div className="border-b border-gray-200 dark:border-gray-800 px-8 py-2 flex items-center gap-2">
          <span className="text-xs text-gray-400 uppercase tracking-wide">Team</span>
          <TeamSwitcher teams={userTeams} currentTeamId={currentTeamId} />
        </div>
      )}
      {children}
    </AuthGuard>
  );
}
