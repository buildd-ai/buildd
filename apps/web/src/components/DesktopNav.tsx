'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navTabs } from './BottomNav';
import { useNeedsInput } from './NeedsInputProvider';

export default function DesktopNav() {
  const pathname = usePathname();
  const { count } = useNeedsInput();

  return (
    <nav className="flex items-center gap-1">
      {navTabs.map((tab) => {
        const isActive = pathname.startsWith(tab.href);
        const showBadge = tab.href === '/app/tasks' && count > 0;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`relative px-3 py-1.5 text-xs font-medium rounded-md transition-colors duration-150 ${
              isActive
                ? 'text-primary bg-surface-3'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-3/50'
            }`}
          >
            {tab.label}
            {showBadge && (
              <span
                data-testid="nav-needs-input-badge"
                className="absolute -top-1 -right-1 flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold rounded-full bg-status-warning text-white"
              >
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
