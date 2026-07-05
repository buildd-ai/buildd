'use client';

import { usePathname } from 'next/navigation';
import { TeamSwitcher } from './TeamSwitcher';
import UserAvatarMenu from './UserAvatarMenu';
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
}: {
  teams?: HeaderTeam[];
  currentTeamId?: string | null;
  userInitial?: string;
}) {
  const pathname = usePathname();
  const title = mobilePageTitle(pathname);

  // Only render on top-level pages (where the title resolves). Detail pages
  // (e.g. /app/missions/[id]) render their own headers.
  if (!title) return null;

  return (
    <div className="md:hidden fixed top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-2.5 bg-surface-2 border-b border-border-default">
      <span className="text-[13px] font-semibold text-text-primary">{title}</span>
      <div className="flex items-center gap-3">
        {teams.length > 0 && <TeamSwitcher teams={teams} currentTeamId={currentTeamId} />}
        <UserAvatarMenu userInitial={userInitial} direction="down" />
      </div>
    </div>
  );
}
