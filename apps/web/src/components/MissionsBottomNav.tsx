'use client';

import Link from 'next/link';
import { useHomeAttentionCount } from '@/lib/home-attention-store';
import { usePathname } from 'next/navigation';
import { isNavActive } from '@/lib/nav-active';
import { NAV_ITEMS } from '@/lib/nav-config';

/**
 * The phone tab bar: five sentence-case labels, no icons, one style on every
 * page. The active tab is ink with a short orange bar on its top edge. One
 * badge: Home's needs-you count, the number Home's headline shows (published
 * by HomeBody; nothing until Home has rendered once).
 */
export default function MissionsBottomNav() {
  const pathname = usePathname();
  const homeCount = useHomeAttentionCount() ?? 0;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 bg-[var(--chrome-bg)] border-t border-border-default backdrop-blur-[12px] pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="flex items-stretch justify-around h-14">
        {NAV_ITEMS.map((tab) => {
          const active = isNavActive(pathname, tab.href);
          const badge = tab.href === '/app/home' && homeCount > 0 ? homeCount : null;

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-h-11 min-w-11 flex-1 items-center justify-center gap-1 px-0.5 text-[13px] transition-colors duration-200 ${
                active ? 'font-semibold text-text-primary' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {active && <span aria-hidden="true" data-testid="nav-active-bar" className="absolute top-0 left-1/2 h-0.5 w-10 -translate-x-1/2 bg-accent" />}
              <span data-testid="nav-tab-label">{tab.label}</span>
              {badge != null && (
                <span data-testid="nav-tab-badge" className="absolute top-1.5 right-1 flex items-center justify-center min-w-4 h-4 px-0.5 text-[11px] leading-none font-semibold tabular-nums bg-accent text-[var(--on-accent)]">
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
