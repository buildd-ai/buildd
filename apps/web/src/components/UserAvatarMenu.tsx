'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { useClickOutside } from '@/hooks/useClickOutside';

interface UserAvatarMenuProps {
  userInitial: string;
  /** 'up' opens above the avatar (desktop sidebar bottom); 'down' opens below (mobile top header). */
  direction?: 'up' | 'down';
}

export default function UserAvatarMenu({ userInitial, direction = 'up' }: UserAvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, useCallback(() => setOpen(false), []));

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`w-8 h-8 bg-accent-soft flex items-center justify-center text-xs font-semibold text-accent-text border border-border-default cursor-pointer hover:border-border-strong transition-colors ${direction === 'up' ? 'mt-2' : ''}`}
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
            className="block px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            Account
          </Link>
          <Link
            href="/app/settings"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            Connections
          </Link>
          <div className="border-t border-border-default" />
          <button
            onClick={() => signOut({ callbackUrl: '/' })}
            className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
