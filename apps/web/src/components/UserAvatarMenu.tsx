'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { useClickOutside } from '@/hooks/useClickOutside';

interface UserAvatarMenuProps {
  userInitial: string;
  /** 'up' opens above the avatar (desktop sidebar bottom); 'down' opens below (mobile top header). */
  direction?: 'up' | 'down';
  /** On an account page (/app/you, /app/settings): no tab owns those, so the avatar shows "you are here". */
  active?: boolean;
}

export default function UserAvatarMenu({ userInitial, direction = 'up', active = false }: UserAvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, useCallback(() => setOpen(false), []));

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={active ? 'page' : undefined}
        // 'down' is the mobile header: a 44px tap target. 'up' is the desktop rail.
        className={`${direction === 'up' ? 'w-8 h-8 mt-2' : 'w-11 h-11'} bg-accent-soft flex items-center justify-center text-xs font-semibold text-accent-text border cursor-pointer hover:border-border-strong transition-colors ${
          active ? 'border-accent border-2' : 'border-border-default'
        }`}
      >
        {userInitial}
      </button>

      {open && (
        <div className={`absolute w-36 bg-card border border-border-strong shadow-[var(--card-shadow)] overflow-hidden z-50 ${
          direction === 'up' ? 'bottom-full left-0 mb-2' : 'top-full right-0 mt-2'
        }`}>
          <Link
            href="/app/you"
            onClick={() => setOpen(false)}
            className="block px-3 py-3 md:py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            Account
          </Link>
          <Link
            href="/app/settings"
            onClick={() => setOpen(false)}
            className="block px-3 py-3 md:py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            Connections
          </Link>
          <div className="border-t border-border-default" />
          <button
            onClick={() => signOut({ callbackUrl: '/' })}
            className="w-full text-left px-3 py-3 md:py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
