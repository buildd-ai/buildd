import type { ReactNode } from 'react';
import { settingsBackHref, settingsItemFor } from './settings-nav';

/**
 * Single source of truth for primary navigation (unified-app-ia §D.2).
 * Consumed by MissionsSidebar (desktop rail) and MissionsBottomNav (mobile
 * tabs) so the two shells cannot drift.
 */
export interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  /** Shown in the desktop sidebar only; filtered out of the mobile bottom tab bar
   * (which is kept to a small tab count — Initiatives is reached via the Home rail). */
  desktopOnly?: boolean;
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
    label: 'Chat',
    href: '/app/chat',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 5h16v11H9l-5 4z" />
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
    label: 'Releases',
    href: '/app/releases',
    desktopOnly: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 2v8m0 4v8" />
        <circle cx="12" cy="12" r="10" />
      </svg>
    ),
  },
  {
    label: 'Initiatives',
    href: '/app/initiatives',
    desktopOnly: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
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

export interface NavContext {
  /** Members get Chat first; operators keep Home (the fleet) first. */
  audience: 'member' | 'operator';
}

/** The mobile tab bar holds at most this many tabs. */
export const MOBILE_TAB_LIMIT = 5;

/**
 * The nav for one person. Chat is always there: it is part of buildd, not an
 * option, and with no key resolved the chat page itself says who can fix it.
 * A member's first item is Chat; on the phone, Team steps off the tab bar to
 * keep it at five (it stays in the desktop rail).
 */
export function navItemsFor(ctx: NavContext, surface: 'desktop' | 'mobile'): NavItem[] {
  let items = NAV_ITEMS;
  if (ctx.audience === 'member') {
    const chat = items.find(i => i.href === '/app/chat');
    items = chat ? [chat, ...items.filter(i => i !== chat)] : items;
  }
  if (surface === 'mobile') {
    items = items.filter(i => !i.desktopOnly);
    if (items.length > MOBILE_TAB_LIMIT) items = items.filter(i => i.href !== '/app/team');
  }
  return items;
}

/**
 * Top-level pages get a mobile header (title + team switcher + account menu).
 * Detail pages return null — they render their own headers.
 */
export function mobilePageTitle(pathname: string): string | null {
  if (pathname === '/app/home' || pathname === '/app/dashboard') return 'Home';
  if (pathname === '/app/missions') return 'Missions';
  if (pathname === '/app/releases') return 'Releases';
  if (pathname === '/app/initiatives') return 'Initiatives';
  if (pathname === '/app/workspaces') return 'Workspaces';
  if (pathname === '/app/tasks') return 'Activity';
  if (pathname === '/app/team') return 'Team';
  if (pathname === '/app/health') return 'Health';
  if (pathname === '/app/artifacts') return 'Artifacts';
  if (pathname === '/app/settings') return 'Settings';
  // Each settings section is a full page on a phone (list → detail); the
  // header names it and carries the back arrow (mobileBackHref).
  const section = settingsItemFor(pathname);
  if (section) return section.label;
  return null;
}

/**
 * Where the mobile header's back arrow points, or null for no arrow. Only
 * settings sections have one: they are the detail half of list → detail, and
 * the phone has no sub-nav to get back to the list.
 */
export function mobileBackHref(pathname: string): string | null {
  return settingsBackHref(pathname);
}

/**
 * Top-level pages whose server component reads `?workspace=`. The header
 * WorkspaceSwitcher only renders here — anywhere else it would be a control that
 * changes the URL and nothing else. nav-config.test.tsx checks each page.tsx.
 */
export const WORKSPACE_FILTERED_PAGES: ReadonlySet<string> = new Set([
  '/app/home',
  '/app/dashboard', // redirect-only (next.config.mjs → /app/home); the header still renders mid-redirect
  '/app/missions',
  '/app/releases',
  '/app/tasks',
  '/app/health',
  '/app/health/usage',
]);

export function showsWorkspaceFilter(pathname: string): boolean {
  return WORKSPACE_FILTERED_PAGES.has(pathname);
}
