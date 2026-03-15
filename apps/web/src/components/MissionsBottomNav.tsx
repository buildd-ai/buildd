'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const missionTabs = [
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
    label: 'You',
    href: '/app/you',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
];

export default function MissionsBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 bg-[var(--chrome-bg)] backdrop-blur-[12px] border-t border-border-strong pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="flex items-center justify-around h-14">
        {missionTabs.map((tab) => {
          const isActive =
            pathname === tab.href ||
            (tab.href === '/app/home' && pathname === '/app/dashboard') ||
            (tab.href === '/app/missions' && pathname.startsWith('/app/objectives')) ||
            (tab.href === '/app/missions' && pathname.startsWith('/app/missions')) ||
            (tab.href === '/app/you' && pathname.startsWith('/app/settings')) ||
            (tab.href === '/app/you' && pathname.startsWith('/app/you'));

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex flex-col items-center justify-center gap-1 flex-1 h-full transition-colors duration-200 ${
                isActive ? 'text-accent-text' : 'text-text-muted'
              }`}
            >
              <span className={`w-[22px] h-[22px] ${isActive ? 'opacity-100' : 'opacity-35'}`}>
                {tab.icon}
              </span>
              <span className={`text-[10px] tracking-[0.3px] ${isActive ? 'font-medium' : 'font-normal'}`}>
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
