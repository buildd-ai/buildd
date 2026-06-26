'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';
import UserAvatarMenu from './UserAvatarMenu';
import TeamSwitcherRail from './TeamSwitcherRail';
import { isNavActive } from '@/lib/nav-active';

interface SidebarTeam {
  id: string;
  name: string;
  slug: string;
}

const sidebarItems = [
  {
    label: 'Home',
    href: '/app/home',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="3" />
        <circle cx="12" cy="12" r="9" strokeDasharray="2 4" />
      </svg>
    ),
  },
  {
    label: 'Missions',
    href: '/app/missions',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="16" y2="12" />
        <line x1="4" y1="18" x2="12" y2="18" />
      </svg>
    ),
  },
  {
    label: 'Activity',
    href: '/app/tasks',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
        <path d="M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        <path d="M9 14l2 2 4-4" />
      </svg>
    ),
  },
  {
    label: 'Team',
    href: '/app/team',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="9" cy="7" r="3" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M15 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
        <path d="M23 21v-1.5a3 3 0 00-3-3h-1" />
      </svg>
    ),
  },
  {
    label: 'Health',
    href: '/app/health',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
      </svg>
    ),
  },
];

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

      {sidebarItems.map((item) => {
        const active = isNavActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`group relative w-10 h-10 flex items-center justify-center rounded-[10px] mb-1 transition-colors ${
              active ? '' : 'hover:bg-accent-soft'
            }`}
            title={item.label}
          >
            <span className={`w-5 h-5 transition-colors ${
              active ? 'text-accent-text' : 'text-text-muted group-hover:text-text-secondary'
            }`}>
              {item.icon}
            </span>
            <span className="pointer-events-none absolute left-[52px] top-1/2 -translate-y-1/2 bg-card text-text-primary border border-border-strong text-[11px] font-medium px-2.5 py-1 rounded-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50">
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
