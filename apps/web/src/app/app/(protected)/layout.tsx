import { cookies } from 'next/headers';
import { AuthGuard } from '@/components/AuthGuard';
import { TeamSwitcher } from '@/components/TeamSwitcher';
import MissionsBottomNav from '@/components/MissionsBottomNav';
import MissionsSidebar from '@/components/MissionsSidebar';
import MobilePageHeader from '@/components/MobilePageHeader';
import { NeedsInputProvider } from '@/components/NeedsInputProvider';
import NeedsInputBanner from '@/components/NeedsInputBanner';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamsWithDetails, getUserWorkspaceIds } from '@/lib/team-access';

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  let userTeams: { id: string; name: string; slug: string }[] = [];
  let currentTeamId: string | null = null;
  let workspaceIds: string[] = [];

  if (user) {
    try {
      userTeams = await getUserTeamsWithDetails(user.id);
    } catch {
      // Teams will be empty, page still renders
    }

    try {
      workspaceIds = await getUserWorkspaceIds(user.id);
    } catch {
      // Workspace IDs will be empty, notifications won't load
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

  const userInitial = user?.name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U';

  return (
    <AuthGuard>
      <NeedsInputProvider workspaceIds={workspaceIds}>
        <div className="flex h-screen overflow-hidden">
          {/* Desktop: collapsed icon sidebar */}
          <MissionsSidebar userInitial={userInitial} />

          {/* Main content area */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* Global notification banner for tasks needing input */}
            <NeedsInputBanner />
            {/* Mobile page header for non-tasks pages */}
            <MobilePageHeader />
            <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
              {children}
            </main>
          </div>
        </div>

        {/* Mobile: bottom tab nav */}
        <MissionsBottomNav />
      </NeedsInputProvider>
    </AuthGuard>
  );
}
