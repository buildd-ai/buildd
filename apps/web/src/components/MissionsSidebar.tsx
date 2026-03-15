'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';

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

const bottomItems: typeof sidebarItems = [];

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
      return pathname.startsWith('/app/missions') || pathname.startsWith('/app/objectives');
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

      <Link
        href="/app/you"
        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold mt-2 cursor-pointer transition-colors ${
          pathname.startsWith('/app/you') || pathname.startsWith('/app/settings') || pathname.startsWith('/app/accounts')
            ? 'bg-accent-text text-white border-2 border-accent-text'
            : 'bg-accent-soft text-accent-text border border-border-default hover:border-border-strong'
        }`}
      >
        {userInitial}
      </Link>
    </div>
  );
}
