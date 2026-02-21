'use client';

import { usePathname } from 'next/navigation';

const PAGE_TITLES: Record<string, string> = {
  '/app/dashboard': 'Dashboard',
  '/app/artifacts': 'Artifacts',
  '/app/settings': 'Settings',
};

export default function MobilePageHeader() {
  const pathname = usePathname();

  // Tasks pages have their own mobile header via MobileTasksLayout
  if (pathname.startsWith('/app/tasks')) return null;

  // Derive title from pathname
  const title = PAGE_TITLES[pathname] || null;
  if (!title) return null;

  return (
    <div className="md:hidden fixed top-0 left-0 right-0 z-10 flex items-center px-4 py-2.5 bg-surface-2 border-b border-border-default">
      <span className="text-[13px] font-semibold text-text-primary">{title}</span>
    </div>
  );
}
