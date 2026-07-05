'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useNeedsInput } from './NeedsInputProvider';
import { isNavActive } from '@/lib/nav-active';
import { NAV_ITEMS } from '@/lib/nav-config';

export default function MissionsBottomNav() {
  const pathname = usePathname();
  const { count: needsInputCount } = useNeedsInput();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 bg-[var(--chrome-bg)] backdrop-blur-[12px] border-t border-border-strong pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="flex items-center justify-around h-14">
        {NAV_ITEMS.map((tab) => {
          const active = isNavActive(pathname, tab.href);
          const showBadge = tab.href === '/app/tasks' && needsInputCount > 0;

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex flex-col items-center justify-center gap-1 flex-1 h-full transition-colors duration-200 ${
                active ? 'text-accent-text' : 'text-text-muted'
              }`}
            >
              <span className={`relative w-[22px] h-[22px] ${active ? 'opacity-100' : 'opacity-35'}`}>
                {tab.icon}
                {showBadge && (
                  <span className="absolute -top-1 -right-2 flex items-center justify-center min-w-[14px] h-3.5 px-0.5 text-[9px] font-bold rounded-full bg-status-warning text-white">
                    {needsInputCount}
                  </span>
                )}
              </span>
              <span className={`text-[10px] tracking-[0.3px] ${active ? 'font-medium' : 'font-normal'}`}>
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
