import { cookies } from 'next/headers';
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
import { getUserTeamsWithDetails, getUserWorkspaceIds, resolveActiveTeamScope, type ActiveTeamScope } from '@/lib/team-access';

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
    const [userTeamsResult, workspaceIdsResult, scopeResult] = await Promise.all([
      // Teams empty on failure, page still renders
      getUserTeamsWithDetails(user.id).catch(() => [] as typeof userTeams),
      // Workspace IDs empty on failure, notifications won't load
      getUserWorkspaceIds(user.id).catch(() => [] as string[]),
      // Active team + its workspaces + its timezone, from the same resolver
      // Home uses so the header never names a team Home isn't showing. The
      // zone comes back in the resolver's own parallel round, never chained
      // after it (dashboard-waterfall.test.ts).
      cookies()
        .then((cookieStore) => resolveActiveTeamScope(user.id, cookieStore.get('buildd-team')?.value))
        // No team on failure; WorkspaceFilter renders nothing, timestamps use the browser zone
        .catch((): ActiveTeamScope => ({ teamId: null, workspaces: [], timezone: null })),
    ]);
    userTeams = userTeamsResult;
    workspaceIds = workspaceIdsResult;
    currentTeamId = scopeResult.teamId;
    teamWorkspaces = scopeResult.workspaces;
    teamTimezone = scopeResult.timezone;
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
