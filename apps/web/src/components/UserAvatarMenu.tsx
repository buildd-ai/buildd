'use client';

import { useState, useRef, useCallback, useId } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { useTheme } from './ThemeProvider';

/** What the menu holds, in order. The theme switch moved here from the rail and the phone Home header. */
export const menuItems = [
  { id: 'account', label: 'Account', href: '/app/settings/account' },
  { id: 'settings', label: 'Settings', href: '/app/settings' },
  { id: 'theme', label: 'Theme' },
  { id: 'sign-out', label: 'Sign out' },
] as const;

const THEME_WORD = { dark: 'Night', light: 'Day', system: 'System' } as const;
const itemClass = 'block w-full text-left px-3 py-3 md:py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors';

interface UserAvatarMenuProps {
  userInitial: string;
  /** 'up' opens above the avatar (desktop sidebar bottom); 'down' opens below (mobile top header). */
  direction?: 'up' | 'down';
  /** On a settings page: no tab owns those, so the avatar shows "you are here". */
  active?: boolean;
}

export default function UserAvatarMenu({ userInitial, direction = 'up', active = false }: UserAvatarMenuProps) {
  const { theme, cycle } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);

  useClickOutside(ref, close);
  useEscapeClose(open, close, triggerRef, ref);

  return (
    <div ref={ref} className="relative">
      {/* Disclosure, not an ARIA menu: the panel holds ordinary links and a
          button, reached with Tab. Escape closes it and refocuses the avatar. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Account menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-current={active ? 'page' : undefined}
        // 'down' is the mobile header: a 44px tap target. 'up' is the desktop rail.
        className={`${direction === 'up' ? 'w-8 h-8 mt-2' : 'w-11 h-11'} bg-surface-2 text-text-primary flex items-center justify-center text-xs font-semibold border cursor-pointer hover:border-border-strong transition-colors ${
          active ? 'border-text-primary border-2' : 'border-border-default'
        }`}
      >
        {userInitial}
      </button>

      {open && (
        <div id={panelId} className={`absolute w-36 bg-card border border-border-strong shadow-[var(--card-shadow)] overflow-hidden z-50 ${
          direction === 'up' ? 'bottom-full left-0 mb-2' : 'top-full right-0 mt-2'
        }`}>
          {menuItems.map((item) => {
            if ('href' in item) {
              return <Link key={item.id} href={item.href} onClick={() => setOpen(false)} className={itemClass}>{item.label}</Link>;
            }
            if (item.id === 'theme') {
              // Cycles Night → Day → System, the order ThemeProvider keeps.
              return (
                <button key={item.id} type="button" onClick={cycle} aria-label={`Switch theme (current: ${THEME_WORD[theme]})`} className={`${itemClass} flex items-center justify-between border-t border-border-default`}>
                  <span>Theme</span><span className="text-text-muted">{THEME_WORD[theme]}</span>
                </button>
              );
            }
            return <button key={item.id} type="button" onClick={() => signOut({ callbackUrl: '/' })} className={`${itemClass} border-t border-border-default`}>{item.label}</button>;
          })}
        </div>
      )}
    </div>
  );
}
