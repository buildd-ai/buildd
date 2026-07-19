'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';
import UserAvatarMenu from './UserAvatarMenu';
import TeamSwitcherRail from './TeamSwitcherRail';
import { isNavActive } from '@/lib/nav-active';
import { NAV_ITEMS } from '@/lib/nav-config';
import { useEscalation } from './EscalationProvider';

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
  const connectionsActive = isNavActive(pathname, '/app/settings');
  const { count: escalationCount } = useEscalation();

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
        const showEscalationBadge = item.href === '/app/home' && escalationCount > 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`group relative w-10 h-10 flex items-center justify-center mb-1 transition-colors ${
              active ? '' : 'hover:bg-accent-soft'
            }`}
          >
            <span className={`relative w-5 h-5 transition-colors ${
              active ? 'text-accent-text' : 'text-text-muted group-hover:text-text-secondary'
            }`}>
              {item.icon}
              {showEscalationBadge && (
                <span className="absolute -top-1 -right-1.5 flex items-center justify-center min-w-[14px] h-3.5 px-0.5 text-[9px] font-bold rounded-full bg-status-error text-white">
                  {escalationCount}
                </span>
              )}
            </span>
            <span className="pointer-events-none absolute left-[52px] top-1/2 -translate-y-1/2 bg-card text-text-primary border border-border-strong text-[11px] font-medium px-2.5 py-1 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50">
              {item.label}
            </span>
          </Link>
        );
      })}

      <div className="flex-1" />

      <ThemeToggle />

      {/* Connections link (unified-app-ia §D.2) */}
      <Link
        href="/app/settings"
        className={`group relative w-10 h-10 flex items-center justify-center mb-1 transition-colors ${
          connectionsActive ? '' : 'hover:bg-accent-soft'
        }`}
      >
        <span className={`w-5 h-5 transition-colors ${
          connectionsActive ? 'text-accent-text' : 'text-text-muted group-hover:text-text-secondary'
        }`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
        <span className="pointer-events-none absolute left-[52px] top-1/2 -translate-y-1/2 bg-card text-text-primary border border-border-strong text-[11px] font-medium px-2.5 py-1 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50">
          Connections
        </span>
      </Link>

      <UserAvatarMenu userInitial={userInitial} />
    </div>
  );
}
