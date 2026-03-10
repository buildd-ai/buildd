import Link from 'next/link';
import { cookies } from 'next/headers';
import { AuthGuard } from '@/components/AuthGuard';
import { TeamSwitcher } from '@/components/TeamSwitcher';
import BottomNav from '@/components/BottomNav';
import DesktopNav from '@/components/DesktopNav';
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
      {/* Desktop top nav: logo | nav links | team switcher */}
      <div className="hidden md:flex h-11 items-center border-b border-border-default bg-surface-2 px-6">
        <div className="flex items-center gap-2 min-w-[140px]">
          <Link href="/app/dashboard" className="text-sm font-bold tracking-tight text-text-primary hover:text-primary transition-colors">
            buildd
          </Link>
        </div>
        <div className="flex-1 flex justify-center">
          <DesktopNav />
        </div>
        <div className="flex items-center justify-end min-w-[140px]">
          {userTeams.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-text-muted uppercase tracking-[2.5px]">Team</span>
              <TeamSwitcher teams={userTeams} currentTeamId={currentTeamId} />
            </div>
          )}
        </div>
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
