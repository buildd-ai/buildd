'use client';

import Link from 'next/link';
import { useHomeAttentionCount } from '@/lib/home-attention-store';
import { usePathname } from 'next/navigation';
import { useNeedsInput } from './NeedsInputProvider';
import { useEscalation } from './EscalationProvider';
import { isNavActive } from '@/lib/nav-active';
import { navItemsFor, type NavContext } from '@/lib/nav-config';

const OPERATOR_NAV: NavContext = { audience: 'operator' };

/**
 * The phone tab bar (mobile chat v3): mono caps labels, no icons, the active
 * tab marked by a short accent bar on its top edge. Shared by every page on a
 * phone; the desktop rail (MissionsSidebar) keeps the icons.
 */
export default function MissionsBottomNav({ nav = OPERATOR_NAV }: { nav?: NavContext }) {
  const pathname = usePathname();
  const homeCount = useHomeAttentionCount();
  const phoneHome = pathname === '/app/home';
  const { count: needsInputCount } = useNeedsInput();
  const { count: escalationCount } = useEscalation();
  const homeBadge = phoneHome ? homeCount ?? 0 : escalationCount;

  return (
    <nav className={`fixed bottom-0 left-0 right-0 z-20 bg-[var(--chrome-bg)] border-t border-border-strong pb-[env(safe-area-inset-bottom)] font-mono md:hidden ${phoneHome ? '' : 'uppercase backdrop-blur-[12px]'}`}>
      <div className="flex items-stretch justify-around h-14">
        {navItemsFor(nav, 'mobile').map((tab) => {
          const active = isNavActive(pathname, tab.href);
          const showBadge = (tab.href === '/app/tasks' && needsInputCount > 0) || (tab.href === '/app/home' && homeBadge > 0);
          const badgeCount = tab.href === '/app/home' ? homeBadge : needsInputCount;

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-h-11 min-w-11 flex-1 items-center justify-center gap-1 px-0.5 text-[11px] tracking-[.02em] min-[390px]:tracking-[.04em] transition-colors duration-200 ${
                active ? (phoneHome ? 'font-bold text-text-primary' : 'text-accent-text') : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {active && !phoneHome && <span aria-hidden="true" data-testid="nav-active-bar" className="absolute top-0 left-1/2 h-[3px] w-10 -translate-x-1/2 bg-accent" />}
              <span data-testid="nav-tab-label">{phoneHome ? tab.label.toLowerCase() : tab.label}</span>
              {showBadge && (
                <span data-testid="nav-tab-badge" className={`absolute top-1.5 right-1 flex items-center justify-center min-w-4 h-4 px-0.5 text-[11px] leading-none md:text-[10px] font-bold ${phoneHome ? 'bg-accent text-[var(--on-accent)]' : 'bg-status-error text-white'}`}>
                  {badgeCount}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
