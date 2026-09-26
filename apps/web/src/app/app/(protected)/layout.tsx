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
import { getUserTeamRole, getUserTeamsWithDetails, getUserWorkspaceIds, resolveActiveTeamScope, type ActiveTeamScope } from '@/lib/team-access';
import { getChatAvailability } from '@/lib/chat-availability';
import { homeAudience } from './home/home-view';
import type { NavContext } from '@/lib/nav-config';

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
  let nav: NavContext = { chat: false, audience: 'operator' };

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
        .catch((): ActiveTeamScope => ({ teamId: null, workspaces: [], timezone: null }))
        // Who sees Chat, and where (lib/chat-availability.ts): needs the team,
        // so it rides the scope's own chain. The capability read short-circuits
        // for every team that hasn't turned chat on. Both are React cache()d,
        // so Home and /app/chat reuse the answer. Off on any failure.
        .then(async (scope) => {
          if (!scope.teamId) return { scope, nav };
          const [avail, role] = await Promise.all([
            getChatAvailability(user.id, scope.teamId).catch(() => null),
            getUserTeamRole(user.id, scope.teamId).catch(() => null),
          ]);
          return { scope, nav: { chat: avail?.available === true, audience: homeAudience(role) } as NavContext };
        }),
    ]);
    userTeams = userTeamsResult;
    workspaceIds = workspaceIdsResult;
    currentTeamId = scopeResult.scope.teamId;
    teamWorkspaces = scopeResult.scope.workspaces;
    teamTimezone = scopeResult.scope.timezone;
    nav = scopeResult.nav;
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
            <MissionsSidebar userInitial={userInitial} teams={userTeams} currentTeamId={currentTeamId} nav={nav} />

            {/* Main content area */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              {/* Mobile page header (top-level pages) + the global banners, as one
                  stack: fixed on mobile so a banner is never hidden under the header. */}
              <MobilePageHeader
                teams={userTeams}
                currentTeamId={currentTeamId}
                userInitial={userInitial}
                workspaces={teamWorkspaces}
                banners={
                  <>
                    {/* Tasks needing input */}
                    <NeedsInputBanner />
                    {/* A connector's auth expired mid-task */}
                    <ConnectorReconnectBanner />
                  </>
                }
              />
              {/* data-scroll-root: overlays lock this, not body (lib/scroll-root.ts).
                  overflow-x-hidden: with overflow-y auto, x would otherwise
                  compute to auto and stray overflow became a sideways touch pan.
                  (overflow-x-clip would compute to hidden here too — clip is only
                  kept when the other axis is visible/clip.) <main> is still an x
                  scroll container, so focus()/scrollIntoView() on content past
                  the right edge can shift it; the fix for that is not
                  overflowing — real horizontal scrollers own an overflow-x-auto
                  box. An inner clip wrapper would avoid it, but page roots rely
                  on <main> as their h-full containing block. */}
              <main data-scroll-root className="flex-1 overflow-y-auto overflow-x-hidden pb-16 md:pb-0">
                {children}
              </main>
            </div>
          </div>

          {/* Silently keep users.timezone in step with the browser */}
          {user && <TimezoneSync knownTimezone={user.timezone} />}

          {/* Mobile: bottom tab nav */}
          <MissionsBottomNav nav={nav} />
        </ConnectorReconnectProvider>
      </NeedsInputProvider>
      </EscalationProvider>
      </DisplayTimezoneProvider>
    </AuthGuard>
  );
}
