'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navTabs } from './BottomNav';

export default function DesktopNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {navTabs.map((tab) => {
        const isActive = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors duration-150 ${
              isActive
                ? 'text-primary bg-surface-3'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-3/50'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
