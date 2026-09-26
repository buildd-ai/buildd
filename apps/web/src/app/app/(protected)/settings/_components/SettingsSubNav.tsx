'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SETTINGS_INDEX_HREF, SETTINGS_NAV, settingsItemFor } from '@/lib/settings-nav';

/**
 * Desktop settings sub-nav: a second column beside the 56px icon rail.
 *
 * The rail holds icons only, so it has no room to expand into ten labelled
 * sections, and header tabs would wrap at ten items. A labelled column keeps
 * every section one click away and shows where you are. Phones get the list and
 * detail pattern instead (the index page is the list), so this is md+ only.
 */
export default function SettingsSubNav() {
  const pathname = usePathname();
  const active = settingsItemFor(pathname);

  return (
    <nav
      aria-label="Settings"
      data-testid="settings-subnav"
      className="hidden md:block w-56 shrink-0 sticky top-0 h-screen overflow-y-auto border-r border-border-default bg-surface-2 px-3 py-6"
    >
      <Link
        href={SETTINGS_INDEX_HREF}
        aria-current={pathname === SETTINGS_INDEX_HREF ? 'page' : undefined}
        className="block px-2 mb-5 text-[15px] font-semibold text-text-primary hover:text-accent-text"
      >
        Settings
      </Link>
      <div className="space-y-5">
        {SETTINGS_NAV.map((group) => (
          <div key={group.label}>
            <div className="section-label px-2 mb-1.5">{group.label}</div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = active?.id === item.id;
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      aria-current={isActive ? 'page' : undefined}
                      data-active={isActive ? 'true' : undefined}
                      className={`block px-2 py-1.5 text-[13px] border-l-2 transition-colors ${
                        isActive
                          ? 'border-accent text-accent-text bg-accent-soft font-medium'
                          : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-surface-3'
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
