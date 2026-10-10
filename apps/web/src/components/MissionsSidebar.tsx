'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import UserAvatarMenu from './UserAvatarMenu';
import ScopeSwitcher from './ScopeSwitcher';
import { isAccountRoute, isNavActive } from '@/lib/nav-active';
import { NAV_ITEMS } from '@/lib/nav-config';
import { useHomeAttentionCount } from '@/lib/home-attention-store';

interface SidebarTeam {
  id: string;
  name: string;
  slug: string;
}

interface MissionsSidebarProps {
  userInitial?: string;
  teams?: SidebarTeam[];
  currentTeamId?: string | null;
  /** The active team's workspaces, for the scope switcher's workspace half. */
  workspaces?: { id: string; name: string }[];
}

/**
 * The desktop side rail: the scope switcher (`Team · Workspace ⌄`) at the top,
 * the five labelled destinations, the avatar menu at the foot (Account,
 * Settings, theme, sign out). One badge: Home's needs-you count, the same
 * number the Home headline and the phone tab show.
 */
export default function MissionsSidebar({ userInitial = 'M', teams = [], currentTeamId = null, workspaces = [] }: MissionsSidebarProps) {
  const pathname = usePathname();
  const homeCount = useHomeAttentionCount() ?? 0;

  return (
    <div className="hidden md:flex w-44 flex-col py-4 bg-[var(--chrome-sidebar)] border-r border-border-default flex-shrink-0">
      <ScopeSwitcher teams={teams} currentTeamId={currentTeamId} workspaces={workspaces} />

      <nav aria-label="Primary" className="flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(pathname, item.href);
          const badge = item.href === '/app/home' && homeCount > 0 ? homeCount : null;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`flex min-h-9 items-center gap-2.5 px-2 text-body transition-colors ${
                active ? 'bg-surface-3 font-semibold text-text-primary' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
              }`}
            >
              <span aria-hidden="true" className={`w-4 h-4 shrink-0 ${active ? 'text-text-primary' : 'text-text-muted'}`}>{item.icon}</span>
              <span data-testid="rail-item-label" className="min-w-0 flex-1 truncate">{item.label}</span>
              {badge != null && (
                <span data-testid="rail-badge" className="flex min-w-5 h-5 items-center justify-center px-1 text-meta font-semibold tabular-nums bg-accent text-[var(--on-accent)]">
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <div className="px-3">
        <UserAvatarMenu userInitial={userInitial} active={isAccountRoute(pathname)} />
      </div>
    </div>
  );
}
