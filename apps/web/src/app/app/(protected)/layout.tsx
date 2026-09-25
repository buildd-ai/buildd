import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { AuthGuard } from '@/components/AuthGuard';
import MissionsBottomNav from '@/components/MissionsBottomNav';
import MissionsSidebar from '@/components/MissionsSidebar';
import MobilePageHeader from '@/components/MobilePageHeader';
import TimezoneSync from '@/components/TimezoneSync';
import { DisplayTimezoneProvider } from '@/components/DisplayTimezone';
import { NeedsInputProvider } from '@/components/NeedsInputProvider';
import NeedsInputBanner from '@/components/NeedsInputBanner';
import { ConnectorReconnectProvider } from '@/components/ConnectorReconnectProvider';
import ConnectorReconnectBanner from '@/components/ConnectorReconnectBanner';
import { EscalationProvider } from '@/components/EscalationProvider';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamsWithDetails, getUserWorkspaceIds } from '@/lib/team-access';
import { getTeamTimezoneSetting } from '@/lib/team-timezone';

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  let userTeams: { id: string; name: string; slug: string }[] = [];
  let currentTeamId: string | null = null;
  let workspaceIds: string[] = [];
  let teamWorkspaces: { id: string; name: string }[] = [];
  let teamTimezone: string | null = null;

  if (user) {
    // These three have no dependency on each other, and this layout re-runs on
    // every navigation under /app (force-dynamic, inherited from
    // app/app/layout.tsx). Run serially they were three separate neon-http
    // round-trip chains before anything painted. Each keeps its own catch so a
    // failure degrades exactly the surface it used to — Promise.all would
    // otherwise reject the whole group on the first error.
    const [userTeamsResult, workspaceIdsResult, cookieStore] = await Promise.all([
      // Teams empty on failure, page still renders
      getUserTeamsWithDetails(user.id).catch(() => [] as typeof userTeams),
      // Workspace IDs empty on failure, notifications won't load
      getUserWorkspaceIds(user.id).catch(() => [] as string[]),
      cookies(),
    ]);
    userTeams = userTeamsResult;
    workspaceIds = workspaceIdsResult;

    const teamCookie = cookieStore.get('buildd-team')?.value;

    // Use cookie value if it matches a valid team, otherwise default to first team
    if (teamCookie && userTeams.some(t => t.id === teamCookie)) {
      currentTeamId = teamCookie;
    } else if (userTeams.length > 0) {
      currentTeamId = userTeams[0].id;
    }

    if (currentTeamId) {
      const teamId = currentTeamId;
      [teamWorkspaces, teamTimezone] = await Promise.all([
        db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.teamId, teamId))
          // teamWorkspaces stays empty; WorkspaceFilter renders nothing
          .catch(() => [] as typeof teamWorkspaces),
        // Never throws; null means "no team zone" → timestamps use the browser's
        getTeamTimezoneSetting(teamId),
      ]);
    }
  }

  const userInitial = user?.name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U';

  return (
    <AuthGuard>
      <DisplayTimezoneProvider teamTimezone={teamTimezone}>
      <EscalationProvider workspaceIds={workspaceIds}>
      <NeedsInputProvider workspaceIds={workspaceIds}>
        <ConnectorReconnectProvider workspaceIds={workspaceIds}>
          <div className="flex h-screen overflow-hidden">
            {/* Desktop: collapsed icon sidebar */}
            <MissionsSidebar userInitial={userInitial} teams={userTeams} currentTeamId={currentTeamId} />

            {/* Main content area */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              {/* Global notification banner for tasks needing input */}
              <NeedsInputBanner />
              {/* Banner shown when a connector's auth expires mid-task */}
              <ConnectorReconnectBanner />
              {/* Mobile page header for non-tasks pages */}
              <MobilePageHeader teams={userTeams} currentTeamId={currentTeamId} userInitial={userInitial} workspaces={teamWorkspaces} />
              <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
                {children}
              </main>
            </div>
          </div>

          {/* Silently keep users.timezone in step with the browser */}
          {user && <TimezoneSync knownTimezone={user.timezone} />}

          {/* Mobile: bottom tab nav */}
          <MissionsBottomNav />
        </ConnectorReconnectProvider>
      </NeedsInputProvider>
      </EscalationProvider>
      </DisplayTimezoneProvider>
    </AuthGuard>
  );
}
