import { cookies } from 'next/headers';
import { AuthGuard } from '@/components/AuthGuard';
import MissionsBottomNav from '@/components/MissionsBottomNav';
import MissionsSidebar from '@/components/MissionsSidebar';
import MobilePageHeader from '@/components/MobilePageHeader';
import TimezoneSync from '@/components/TimezoneSync';
import AppFreshness from '@/components/AppFreshness';
import { DisplayTimezoneProvider } from '@/components/DisplayTimezone';
import { NeedsInputProvider } from '@/components/NeedsInputProvider';
import NeedsInputBanner from '@/components/NeedsInputBanner';
import { ConnectorReconnectProvider } from '@/components/ConnectorReconnectProvider';
import ConnectorReconnectBanner from '@/components/ConnectorReconnectBanner';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isBillingEnforced } from '@buildd/core/entitlements';
import { loadAppChrome } from '@/lib/app-chrome';
import { peekChatAvailability } from '@/lib/chat-availability';
import { chatEntryFromAvailability } from '@/components/chat/ChatSetupCard';
import { ChatEntryProvider, ChatShortcut, type ChatEntryValue } from '@/components/chat/ChatEntry';
import { KeyHintsProvider } from '@/components/KeyHints';
import { ChatCanvasProvider } from '@/components/chat/ChatCanvas';

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
  // Create buttons open chat when it's available (components/chat/ChatEntry.tsx).
  let chatEntry: ChatEntryValue = { available: false, teamId: null, setupHref: null };

  if (user) {
    // What every page shares costs two statements in one round, scoped to the
    // user in SQL and kept 30 s (lib/app-chrome.ts, spec 3ef37387 R-17). This
    // layout re-runs on every navigation and every live refresh under /app
    // (force-dynamic, inherited from app/app/layout.tsx), so a warm one reads
    // nothing. On failure the shell still renders: no teams, no workspace
    // scope, timestamps in the browser zone.
    const chrome = await cookies()
      .then((cookieStore) => loadAppChrome(user.id, cookieStore.get('buildd-team')?.value))
      .catch(() => null);
    if (chrome) {
      userTeams = chrome.teams;
      workspaceIds = chrome.workspaceIds;
      currentTeamId = chrome.scope.teamId;
      teamWorkspaces = chrome.scope.workspaces;
      teamTimezone = chrome.scope.timezone;
    }
    // Whether a chat turn can run only steers the create buttons (chat vs the
    // form); the Chat nav entry is always there. Resolving it can call the
    // model-policy service, so the shell never waits: it takes the last answer
    // and refreshes after the response. A cold cache paints the form buttons
    // and ChatEntryProvider asks once, after paint.
    if (currentTeamId) {
      const avail = peekChatAvailability(user.id, currentTeamId);
      chatEntry = { ...chatEntryFromAvailability(avail, currentTeamId), pending: avail === null };
    }
  }

  const userInitial = user?.name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U';

  return (
    <AuthGuard>
      <KeyHintsProvider value={user?.showKeyboardHints === true}>
      <ChatEntryProvider value={chatEntry}>
      {/* The chat canvas, summonable over any page (knowledge-base: buildd/design/chat-canvas.md). */}
      <ChatCanvasProvider
        teamId={chatEntry.teamId}
        workspaces={teamWorkspaces}
        viewerName={user?.name?.trim().split(/\s+/)[0] ?? user?.email?.split('@')[0] ?? null}
      >
      <ChatShortcut />
      <DisplayTimezoneProvider teamTimezone={teamTimezone}>
      <NeedsInputProvider workspaceIds={workspaceIds}>
        <ConnectorReconnectProvider workspaceIds={workspaceIds}>
          <div className="flex h-screen overflow-hidden">
            {/* Desktop: the labelled side rail */}
            <MissionsSidebar userInitial={userInitial} teams={userTeams} currentTeamId={currentTeamId} workspaces={teamWorkspaces} />

            {/* Main content area */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              {/* Mobile page header (top-level pages) + the global banners, as one
                  stack: fixed on mobile so a banner is never hidden under the header. */}
              <MobilePageHeader
                teams={userTeams}
                currentTeamId={currentTeamId}
                userInitial={userInitial}
                workspaces={teamWorkspaces}
                billing={isBillingEnforced()}
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

          {/* Catch up on resume / reconnect / back-nav, and pull-to-refresh on mobile */}
          <AppFreshness />

          {/* Silently keep users.timezone in step with the browser */}
          {user && <TimezoneSync knownTimezone={user.timezone} />}

          {/* Mobile: bottom tab nav */}
          <MissionsBottomNav />
        </ConnectorReconnectProvider>
      </NeedsInputProvider>
      </DisplayTimezoneProvider>
      </ChatCanvasProvider>
      </ChatEntryProvider>
      </KeyHintsProvider>
    </AuthGuard>
  );
}
