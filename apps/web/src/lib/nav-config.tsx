import type { ReactNode } from 'react';

/**
 * Single source of truth for primary navigation (unified-app-ia §D.2).
 * Consumed by MissionsSidebar (desktop rail) and MissionsBottomNav (mobile
 * tabs) so the two shells cannot drift.
 */
export interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
}

export const NAV_ITEMS: NavItem[] = [
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

/**
 * Top-level pages get a mobile header (title + team switcher + account menu).
 * Detail pages return null — they render their own headers.
 */
export function mobilePageTitle(pathname: string): string | null {
  if (pathname === '/app/home' || pathname === '/app/dashboard') return 'Home';
  if (pathname === '/app/missions') return 'Missions';
  if (pathname === '/app/workspaces') return 'Workspaces';
  if (pathname === '/app/tasks') return 'Activity';
  if (pathname === '/app/team') return 'Team';
  if (pathname === '/app/health') return 'Health';
  if (pathname === '/app/artifacts') return 'Artifacts';
  if (pathname === '/app/you') return 'Account';
  if (pathname === '/app/settings') return 'Connections';
  return null;
}
