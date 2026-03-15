'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { useClickOutside } from '@/hooks/useClickOutside';

interface UserAvatarMenuProps {
  userInitial: string;
}

export default function UserAvatarMenu({ userInitial }: UserAvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, useCallback(() => setOpen(false), []));

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-8 h-8 rounded-full bg-accent-soft flex items-center justify-center text-xs font-semibold text-accent-text border border-border-default mt-2 cursor-pointer hover:border-border-strong transition-colors"
      >
        {userInitial}
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-36 bg-card border border-border-strong rounded-lg shadow-lg overflow-hidden z-50">
          <Link
            href="/app/you"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            Profile
          </Link>
          <Link
            href="/app/settings"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            Settings
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
