'use client';

import { usePathname } from 'next/navigation';
import { TeamSwitcher } from './TeamSwitcher';
import UserAvatarMenu from './UserAvatarMenu';
import { WorkspaceFilter } from './WorkspaceFilter';
import { mobilePageTitle } from '@/lib/nav-config';

interface HeaderTeam {
  id: string;
  name: string;
  slug: string;
}

export default function MobilePageHeader({
  teams = [],
  currentTeamId = null,
  userInitial = 'U',
  workspaces = [],
}: {
  teams?: HeaderTeam[];
  currentTeamId?: string | null;
  userInitial?: string;
  workspaces?: { id: string; name: string }[];
}) {
  const pathname = usePathname();
  const title = mobilePageTitle(pathname);
  const currentTeam = teams.find(t => t.id === currentTeamId) ?? teams[0] ?? null;

  // Only render on top-level pages (where the title resolves). Detail pages
  // (e.g. /app/missions/[id]) render their own headers.
  if (!title) return null;

  return (
    <div className="md:hidden fixed top-0 left-0 right-0 z-10 flex items-center justify-between gap-2 px-4 py-2.5 bg-surface-2 border-b border-border-default">
      {/* Breadcrumb cluster: `Page · Team ⌄`, where the team segment is itself the
          switcher (turbopuffer/Vercel pattern) rather than a separate glyph in the
          right-hand cluster. Anchoring the menu here also keeps it on-screen. */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[13px] font-normal">
        <span className="truncate font-semibold text-text-primary">{title}</span>
        {currentTeam && (
          <>
            <span className="text-text-muted shrink-0" aria-hidden="true">·</span>
            <TeamSwitcher teams={teams} currentTeamId={currentTeamId} />
          </>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {workspaces.length > 0 && <WorkspaceFilter workspaces={workspaces} />}
        <UserAvatarMenu userInitial={userInitial} direction="down" />
      </div>
    </div>
  );
}
