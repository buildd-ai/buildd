'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { healthItemFor, healthNavFor } from '@/lib/health-nav';

/**
 * Health's second column, the same shape as Settings: a labelled list beside
 * the icon rail on desktop. Phones get a scrolling row of the same links
 * above the page, because Overview is a page in its own right (Settings has
 * a list page instead). The `?workspace=` filter rides along between pages.
 */
export default function HealthSubNav({ isOperator }: { isOperator: boolean }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const active = healthItemFor(pathname);
  const items = healthNavFor(isOperator);
  const workspace = params.get('workspace');
  const href = (base: string) => (workspace ? `${base}?workspace=${encodeURIComponent(workspace)}` : base);

  return (
    <>
      <div className="hidden md:block w-56 shrink-0 border-r border-border-default bg-surface-2">
        <nav aria-label="Health" data-testid="health-subnav" className="sticky top-0 max-h-screen overflow-y-auto px-3 py-6">
          <div className="block px-2 mb-5 text-lede font-semibold text-text-primary">Health</div>
          <ul className="space-y-0.5">
            {items.map(item => {
              const isActive = active?.id === item.id;
              return (
                <li key={item.id}>
                  <Link
                    href={href(item.href)}
                    aria-current={isActive ? 'page' : undefined}
                    data-active={isActive ? 'true' : undefined}
                    className={`block px-2 py-1.5 text-body border-l-2 transition-colors ${
                      isActive
                        ? 'border-text-primary text-text-primary font-semibold'
                        : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-surface-3'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <nav
        aria-label="Health"
        data-testid="health-subnav-mobile"
        className="md:hidden flex gap-1 overflow-x-auto px-4 mt-[var(--mobile-header-h,0px)] border-b border-border-default bg-surface-1"
      >
        {items.map(item => {
          const isActive = active?.id === item.id;
          return (
            <Link
              key={item.id}
              href={href(item.href)}
              aria-current={isActive ? 'page' : undefined}
              className={`shrink-0 px-3 min-h-11 flex items-center text-body border-b-2 ${
                isActive ? 'border-text-primary text-text-primary font-semibold' : 'border-transparent text-text-secondary'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
