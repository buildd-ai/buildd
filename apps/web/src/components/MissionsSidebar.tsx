'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';
import UserAvatarMenu from './UserAvatarMenu';
import TeamSwitcherRail from './TeamSwitcherRail';
import { isNavActive } from '@/lib/nav-active';
import { NAV_ITEMS } from '@/lib/nav-config';

interface SidebarTeam {
  id: string;
  name: string;
  slug: string;
}

interface MissionsSidebarProps {
  userInitial?: string;
  teams?: SidebarTeam[];
  currentTeamId?: string | null;
}

export default function MissionsSidebar({ userInitial = 'M', teams = [], currentTeamId = null }: MissionsSidebarProps) {
  const pathname = usePathname();

  return (
    <div className="hidden md:flex w-14 flex-col items-center py-4 bg-[var(--chrome-sidebar)] border-r border-border-default flex-shrink-0">
      {teams.length > 0 && (
        <>
          <TeamSwitcherRail teams={teams} currentTeamId={currentTeamId} />
          <div className="w-6 h-px bg-border-default mb-2" />
        </>
      )}

      {NAV_ITEMS.map((item) => {
        const active = isNavActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`group relative w-10 h-10 flex items-center justify-center mb-1 transition-colors ${
              active ? '' : 'hover:bg-accent-soft'
            }`}
          >
            <span className={`w-5 h-5 transition-colors ${
              active ? 'text-accent-text' : 'text-text-muted group-hover:text-text-secondary'
            }`}>
              {item.icon}
            </span>
            <span className="pointer-events-none absolute left-[52px] top-1/2 -translate-y-1/2 bg-card text-text-primary border border-border-strong text-[11px] font-medium px-2.5 py-1 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50">
              {item.label}
            </span>
          </Link>
        );
      })}

      <div className="flex-1" />

      <ThemeToggle />

      <UserAvatarMenu userInitial={userInitial} />
    </div>
  );
}
