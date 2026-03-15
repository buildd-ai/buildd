'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useNeedsInput } from './NeedsInputProvider';

export const navTabs = [
  {
    label: 'Objectives',
    href: '/app/objectives',
    icon: (active: boolean) => (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2.5 : 2}
          d="M13 10V3L4 14h7v7l9-11h-7z"
        />
      </svg>
    ),
  },
  {
    label: 'Schedules',
    href: '/app/schedules',
    icon: (active: boolean) => (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2.5 : 2}
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
  },
  {
    label: 'Tasks',
    href: '/app/tasks',
    icon: (active: boolean) => (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2.5 : 2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
        />
      </svg>
    ),
  },
  {
    label: 'Dashboard',
    href: '/app/dashboard',
    icon: (active: boolean) => (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2.5 : 2}
          d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
        />
      </svg>
    ),
  },
  {
    label: 'Artifacts',
    href: '/app/artifacts',
    icon: (active: boolean) => (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2.5 : 2}
          d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
        />
      </svg>
    ),
  },
  {
    label: 'Account',
    href: '/app/you',
    icon: (active: boolean) => (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={active ? 2.5 : 2}
          d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"
        />
        <circle cx="12" cy="7" r="4" strokeWidth={active ? 2.5 : 2} />
      </svg>
    ),
  },
];

export default function BottomNav() {
  const pathname = usePathname();
  const { count } = useNeedsInput();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 h-16 bg-surface-2 border-t border-border-default pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="flex items-center justify-around h-full">
        {navTabs.map((tab) => {
          const isActive = pathname.startsWith(tab.href);
          const showBadge = tab.href === '/app/tasks' && count > 0;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`relative flex flex-col items-center justify-center gap-1 flex-1 h-full transition-colors duration-200 ${
                isActive ? 'text-primary' : 'text-text-secondary'
              }`}
            >
              <span className="relative">
                {tab.icon(isActive)}
                {showBadge && (
                  <span
                    data-testid="mobile-needs-input-badge"
                    className="absolute -top-1 -right-2 flex items-center justify-center min-w-[14px] h-3.5 px-0.5 text-[9px] font-bold rounded-full bg-status-warning text-white"
                  >
                    {count}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
