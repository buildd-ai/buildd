import type { ReactNode } from 'react';
import { settingsBackHref, settingsItemAs, settingsItemFor } from './settings-nav';

export interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
}

/**
 * The five primary destinations, the same on a phone (MissionsBottomNav) and
 * on desktop (MissionsSidebar). Owner decision, Oct 9: Releases and
 * Initiatives live under Missions, Team under Settings; their routes still
 * resolve and nav-active.ts lights the owning item.
 */
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
  },  {
    label: 'Missions',
    href: '/app/missions',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="16" y2="12" />
        <line x1="4" y1="18" x2="12" y2="18" />
      </svg>
    ),
  },  {
    label: 'Activity',
    href: '/app/tasks',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
        <path d="M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        <path d="M9 14l2 2 4-4" />
      </svg>
    ),
  },  {
    label: 'Health',
    href: '/app/health',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
      </svg>
    ),
  },  {
    label: 'Chat',
    href: '/app/chat',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 5h16v11H9l-5 4z" />
      </svg>
    ),
  },];

/** The mobile tab bar holds at most this many tabs; the nav is exactly this long. */
export const MOBILE_TAB_LIMIT = 5;

/**
 * Health's sections, in sidebar order: the one list behind the Health sub-nav,
 * its phone link row and the mobile header title. Kept here, in core
 * navigation, because the mobile header (core) names these pages; the Health
 * module reads it through lib/health-nav.ts. Failures, Usage, Insights and
 * Operator are buildd's own analytics, moved to the private admin app: only
 * platform operators see them (lib/platform-operator.ts).
 */
export type HealthSectionId = 'overview' | 'failures' | 'runners' | 'usage' | 'insights' | 'operator';

export interface HealthNavItem {
  id: HealthSectionId;
  label: string;
  href: string;
  /** Only buildd platform operators see this item and its route. */
  operatorOnly?: boolean;
}

export const HEALTH_INDEX_HREF = '/app/health';

export const HEALTH_NAV: readonly HealthNavItem[] = [
  { id: 'overview', label: 'Overview', href: HEALTH_INDEX_HREF },
  { id: 'failures', label: 'Failures', href: '/app/health/failures', operatorOnly: true },
  { id: 'runners', label: 'Runners & capacity', href: '/app/health/runners' },
  { id: 'usage', label: 'Usage', href: '/app/health/usage', operatorOnly: true },
  { id: 'insights', label: 'Insights', href: '/app/health/insights', operatorOnly: true },
  { id: 'operator', label: 'Operator', href: '/app/health/operator', operatorOnly: true },
];

/** The Health section a path belongs to, or null outside Health. */
export function healthItemFor(pathname: string): HealthNavItem | null {
  if (pathname === HEALTH_INDEX_HREF) return HEALTH_NAV[0];
  for (const item of HEALTH_NAV) {
    if (item.href === HEALTH_INDEX_HREF) continue;
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return item;
  }
  return null;
}

/** `/app/workspaces/:id/memory` — a workspace sub-page that needs a phone title and a way back. */
const WORKSPACE_MEMORY_PATH = /^\/app\/workspaces\/([^/]+)\/memory$/;

/**
 * Top-level pages get a mobile header (title + team switcher + account menu).
 * Detail pages return null — they render their own headers.
 */
export function mobilePageTitle(pathname: string, opts: { billing?: boolean } = {}): string | null {
  if (pathname === '/app/home' || pathname === '/app/dashboard') return 'Home';
  if (pathname === '/app/chat') return 'Chat';
  if (pathname === '/app/missions') return 'Missions';
  if (pathname === '/app/releases') return 'Releases';
  if (pathname === '/app/initiatives') return 'Initiatives';
  if (pathname === '/app/workspaces') return 'Workspaces';
  if (pathname === '/app/tasks') return 'Activity';
  if (pathname === '/app/team') return 'Team';
  // Every Health page is a top-level page with the Health link row; Overview
  // keeps the section's name.
  const healthItem = healthItemFor(pathname);
  if (healthItem) return healthItem.id === 'overview' ? 'Health' : healthItem.label;
  if (WORKSPACE_MEMORY_PATH.test(pathname)) return 'Memory';
  if (pathname === '/app/settings') return 'Settings';
  // Each settings section is a full page on a phone (list → detail); the
  // header names it and carries the back arrow (mobileBackHref).
  const section = settingsItemFor(pathname);
  if (section) return settingsItemAs(section, { billing: opts.billing ?? false }).label;
  return null;
}

/**
 * Where the mobile header's back arrow points, or null for no arrow. Only
 * settings sections have one: they are the detail half of list → detail, and
 * the phone has no sub-nav to get back to the list.
 */
export function mobileBackHref(pathname: string): string | null {
  const memory = WORKSPACE_MEMORY_PATH.exec(pathname);
  if (memory) return `/app/workspaces/${memory[1]}`;
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
  '/app/health/failures',
  '/app/health/runners',
  '/app/health/operator',
  '/app/health/usage',
]);

export function showsWorkspaceFilter(pathname: string): boolean {
  return WORKSPACE_FILTERED_PAGES.has(pathname);
}
