import { cookies } from 'next/headers';
import { AuthGuard } from '@/components/AuthGuard';
import { TeamSwitcher } from '@/components/TeamSwitcher';
import BottomNav from '@/components/BottomNav';
import MobilePageHeader from '@/components/MobilePageHeader';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamsWithDetails } from '@/lib/team-access';

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  let userTeams: { id: string; name: string; slug: string }[] = [];
  let currentTeamId: string | null = null;

  if (user) {
    try {
      userTeams = await getUserTeamsWithDetails(user.id);
    } catch {
      // Teams will be empty, page still renders
    }

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
      {/* Compact desktop header: team switcher + alpha badge */}
      <div className="hidden md:flex h-10 items-center justify-between border-b border-border-default bg-surface-2 px-8">
        {userTeams.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-text-muted uppercase tracking-[2.5px]">Team</span>
            <TeamSwitcher teams={userTeams} currentTeamId={currentTeamId} />
          </div>
        ) : (
          <div />
        )}
        <span className="px-2 py-0.5 text-[10px] font-mono text-text-muted bg-surface-3 rounded-full">
          Alpha
        </span>
      </div>
      {/* Mobile page header for non-tasks pages */}
      <MobilePageHeader />
      <div className="pb-16 md:pb-0">
        {children}
      </div>
      <BottomNav />
    </AuthGuard>
  );
}
