'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';
import UserAvatarMenu from './UserAvatarMenu';

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
    label: 'Artifacts',
    href: '/app/artifacts',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14,2 14,8 20,8" />
      </svg>
    ),
  },
];

const bottomItems = [
  {
    label: 'Settings',
    href: '/app/settings',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
];

interface MissionsSidebarProps {
  userInitial?: string;
}

export default function MissionsSidebar({ userInitial = 'M' }: MissionsSidebarProps) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === '/app/home') {
      return pathname === '/app/home' || pathname === '/app/dashboard';
    }
    if (href === '/app/missions') {
      return pathname.startsWith('/app/missions');
    }
    if (href === '/app/team') {
      return pathname.startsWith('/app/team');
    }
    return pathname.startsWith(href);
  };

  return (
    <div className="hidden md:flex w-14 flex-col items-center py-4 bg-[var(--chrome-sidebar)] border-r border-border-default flex-shrink-0">
      {sidebarItems.map((item) => {
        const active = isActive(item.href);
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

      <div className="w-6 h-px bg-border-default my-2" />
      <div className="flex-1" />

      {bottomItems.map((item) => {
        const active = isActive(item.href);
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

      <ThemeToggle />

      <UserAvatarMenu userInitial={userInitial} />
    </div>
  );
}
