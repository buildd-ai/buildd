'use client';

import { usePathname } from 'next/navigation';
import { TeamSwitcher } from './TeamSwitcher';

interface HeaderTeam {
  id: string;
  name: string;
  slug: string;
}

// Top-level pages get a mobile header with the team switcher. Detail pages
// (e.g. /app/missions/[id]) are excluded — they render their own headers.
function titleForPath(pathname: string): string | null {
  if (pathname === '/app/home' || pathname === '/app/dashboard') return 'Home';
  if (pathname === '/app/missions') return 'Missions';
  if (pathname === '/app/workspaces') return 'Workspaces';
  if (pathname === '/app/tasks') return 'Activity';
  if (pathname === '/app/artifacts') return 'Artifacts';
  if (pathname === '/app/settings') return 'Settings';
  return null;
}

export default function MobilePageHeader({
  teams = [],
  currentTeamId = null,
}: {
  teams?: HeaderTeam[];
  currentTeamId?: string | null;
}) {
  const pathname = usePathname();
  const title = titleForPath(pathname);

  // Only render on top-level pages (where the title resolves).
  if (!title) return null;

  return (
    <div className="md:hidden fixed top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-2.5 bg-surface-2 border-b border-border-default">
      <span className="text-[13px] font-semibold text-text-primary">{title}</span>
      {teams.length > 0 && <TeamSwitcher teams={teams} currentTeamId={currentTeamId} />}
    </div>
  );
}
